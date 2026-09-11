# Plan: clipboard (copy / cut / paste between the host clipboard and the nested page)

## Why

Nothing clipboard-shaped works today, for three independent reasons found 2026-09-10:

1. **The viewer forwards no Ctrl/Cmd combo at all** (`viewer.mjs` keydown: `if (e.ctrlKey ||
   e.metaKey || hostKey(e)) return;`). Ctrl+C/X/V/A/Z never reach the engine — the comment says
   they "stay with the host browser", which is right for Ctrl+T/W/L/R and wrong for editing.
2. **The engine pasteboard is a stub**: `platform/emscripten/PasteboardEmscripten.cpp` (in the
   WebKit patch) returns empty from every read and drops every write; `BibEditorClient`'s key
   map (`commandForKeyDown`) knows Backspace/Delete/arrows/Home/End only, so even a forwarded
   Ctrl+C would map to no editor command.
3. **`navigator.clipboard` does not exist in guest pages**: `AsyncClipboardAPIEnabled` defaults
   false at the raw-WebCore layer (same empty-defaults family as localStorage / rIC, main.cpp),
   and the generic `Pasteboard::allPasteboardItemInfo` / `readString(index,…)` /
   `readBuffer(index,…)` that `Modules/async-clipboard` calls are `#if COCOA||GTK||WPE` →
   `nullopt` here, so even switched on, `readText()`/`read()` would reject.

Everything else in WebKit is platform-neutral and already compiled: `Editor::copy/cut/paste`,
the `copy`/`cut`/`paste` DOM events with `clipboardData` (`DataTransfer` over our
`Pasteboard`), `execCommand('copy')` under the default `ClipboardAccessPolicy::RequiresUserGesture`,
`Clipboard::writeText/write/readText/read`. The port runs WebKit's **legacy pasteboard path**
(`DeprecatedGlobalSettings::customPasteboardDataEnabled()` is false and nothing sets it): reads
are `typesForLegacyUnsafeBindings()` + `readString(type)`, DOM `setData` commits arrive as
`clear()` followed by one `writeString(type, string)` per type, `Editor::copy` arrives as
`write(PasteboardWebContent{text, markup})` (`writePlainText` inside text controls), and
`Clipboard::writeText` as `writeCustomData` with one platform string. A small in-engine store
covers all of it.

## Design in one paragraph

The engine owns an in-memory **pasteboard store** (typed items: strings for text/plain,
text/html, text/uri-list; bytes for images; a change count). The host is the only thing that
talks to the real clipboard, in exactly two moments that browsers already gate for us:
**paste** — whatever key the host browser binds to paste fires a host `paste` event on the
focused canvas; its `clipboardData` reaches the store *before* the key reaches the engine, so
WebKit's `Editor::paste` and the guest's `paste` event see fresh content; **copy** — every store
mutation the engine makes (Ctrl+C, `cut`, `execCommand('copy')`, a `copy` handler's
`setData`, `navigator.clipboard.writeText`) is coalesced into one `bibChrome("clipboard")`
signal, and the viewer writes it to the host clipboard with the async Clipboard API, itself
gated on a recent user input. No manifest permission is added: reads only ever happen via the
paste event, writes ride transient activation. Guest `navigator.clipboard.readText()/read()`
without a paste gesture is **denied** (NotAllowedError, what a site sees when the user
declines the permission prompt) — see § Not in v1 for the `clipboardRead` upgrade path.

## Steps

### 0. Probe the two host facts the design rests on (both browsers, ~1 h)

A throwaway page loaded as an *extension page* (a viewer-shaped `?stub=1` page is enough — the
origin is what matters), driven by real key presses (gui-testing skill; synthetic events do not
carry activation). Record answers in open-questions.md as #14, then decide the fallbacks below.

- (a) With a focused `<canvas tabindex=0>` and nothing editable on the page, does Ctrl+V fire a
  `paste` event on the canvas, with `clipboardData.getData('text/plain'|'text/html')`,
  `.types`, and `.files` (a copied PNG) all readable, without a prompt? Expected yes on
  Chrome; Firefox is the one to verify (it dispatches paste to the focused element, and Firefox
  ≥ 125's paste context-menu prompt is for `navigator.clipboard.read`, not the event).
  **Fallback if no**: make the key sink a hidden 1-px `<textarea>` instead of the canvas
  (paste events are unconditional on editable targets). That is also where the IME plan
  (rendering-input.md) wants the key sink to end up, so write the paste listener against
  "the key sink element", not `canvas` by name.
- (b) Does `navigator.clipboard.write([ClipboardItem{text/plain, text/html}])` (and
  `writeText`) succeed ~10–50 ms after a real keydown, from the extension page, with **no**
  `clipboardWrite` permission? Chrome auto-grants clipboard-write to the active tab; Firefox
  needs transient activation (5 s window, not consumed by the write). **Fallback if no on
  Firefox**: add `clipboardWrite` (Firefox warning "Input data to the clipboard"; Chrome
  "Modify data you copy and paste") — record the warning text in distribution.md if it comes
  to that. Also check `text/html` in `ClipboardItem` on Firefox; if unsupported, fall back to
  `writeText` (plain only) on a rejected `write()`.
- (c) Does headless Chrome's in-memory clipboard round-trip through the same page (a copy then a
  paste event)? Decides whether tier-2 can test end to end (it should: `HeadlessClipboard`).
  Same question for headless Firefox (`widget/headless` has a clipboard too).

### 1. Engine: store, pasteboard, key map, ABI (C++; ~250 lines, mostly patch)

Build from this worktree (`bash scripts/build-engine.sh`, ~1.5 min); WebKit-tree edits follow
worktrees.md § WebKit-tree changes (edit under the main checkout's tree, re-export the patch).

- **Store** — new `platform/emscripten/PasteboardEmscripten.h` (patch) declaring
  `WebCore::EmscriptenPasteboardStore` (singleton): `Vector<Item{type, String text, RefPtr<SharedBuffer> bytes, String name}>`,
  `int64_t changeCount`, `String origin`; `replace(items)`, `clear()`, `writeString(type,text)`,
  `writeBytes(type,bytes,name)`, `readString(type)`, `items()`, plus a `Function<void()>
  writeObserver` the embedder installs. Types are normalized on the way in (`text/plain;charset=utf-8`
  → `text/plain`; DataTransfer already maps `text`/`url` before reaching us). Every mutating call
  from WebCore bumps `changeCount` and schedules the observer once per run-loop turn
  (`RunLoop::main().dispatch` guarded by a `pending` flag) so `clear()`+N×`writeString` from a
  `copy` handler becomes one host write.
- **`PasteboardEmscripten.cpp`** rewritten over the store: `hasData`, `typesForLegacyUnsafeBindings`
  (string types only — DataTransfer appends `"Files"` itself), `readString`, `writeString`,
  `clear()`/`clear(type)`, `read(PasteboardPlainText&, …, index)`, `read(PasteboardFileReader&, index)`
  (hands image bytes to `readBuffer(name, type, buffer)` when `shouldReadBuffer(type)` — this is
  both `clipboardData.files` on paste and the async API's `ClipboardImageReader`),
  `fileContentState()` = `InMemoryImage` when any item has bytes, `write(PasteboardWebContent)`
  (text + markup), `writePlainText`, `writeMarkup`, `write(PasteboardURL)` (text/plain +
  text/uri-list), `writeCustomData` (each `forEachPlatformStringOrBuffer` entry → store; origin
  kept for `readOrigin`), `write(PasteboardImage)` (resourceData/MIME → bytes; only
  `Editor::copyImage` reaches it, which needs a context menu we don't have — cheap, so do it).
  `read(PasteboardWebContentReader&)` stays `notImplemented` (its `readHTML` etc. are
  `#if COCOA||GTK||WPE` in WebContentReader.h; consequence in § Not in v1). `typesSafeForBindings`,
  `readStringInCustomData` stay empty (custom-data path is off).
- **Generic index functions** — `platform/Pasteboard.cpp`: under `#if defined(__EMSCRIPTEN__)`
  route `allPasteboardItemInfo()` (one `PasteboardItemInfo` per store item with
  `webSafeTypesByFidelity`/`platformTypesByFidelity` = `[type]`, `isNonTextType` for bytes, a
  possibly **empty** vector — `nullopt` means "denied" to `Clipboard::readText`),
  `pasteboardItemInfo(i)`, `readString(i,type)`, `readBuffer(i,type)`, `readURL(i,title)` to the
  store. `Pasteboard.h`: extend the `changeCount()` declaration guard so ours is real (the
  `else { return 0; }` branch would make `Clipboard::read()` reuse a stale session forever).
- **`editing/emscripten/EditorEmscripten.cpp`**: type strings `text/plain;charset=utf-8` →
  `text/plain` (they were cribbed from libwpe; ours normalizes anyway, keep them honest).
- **Key map** (`BibPageClients.h` `commandForKeyDown`), Ctrl *or* Meta (Mac hosts send Meta):
  C→`Copy`, X→`Cut`, V→`Paste`, Shift+V→`PasteAsPlainText`, A→`SelectAll`, Z→`Undo`,
  Y / Shift+Z→`Redo`; plus Ctrl+Insert→`Copy`, Shift+Insert→`Paste`, Shift+Delete→`Cut`. Undo/Redo
  will not work (`registerUndoStep` is empty, `canUndo` false) — file an issue with the other
  editing-key gaps (Ctrl+arrows/Backspace word ops, Shift+Home/End, PageUp/Down) rather than
  widen this plan. `requestDOMPasteAccess` stays `DeniedForGesture` (v1 policy above).
- **Settings** (main.cpp next to the other empty-defaults fixes): `setAsyncClipboardAPIEnabled(true)`.
  Leave `JavaScriptCanAccessClipboard`/`DOMPasteAllowed`/`DOMPasteAccessRequestsEnabled` false:
  that is exactly "copy needs a gesture, DOM-initiated paste needs permission".
- **ABI** (`bib_abi.h`, mirror in `abi.mjs` if any constant is added):
  - export `void bib_clipboard_set(char* json, char* bytes, int len)` — replaces the store.
    `json = {"items":[{"type":"text/plain","text":"…"},{"type":"text/html","text":"…"},
    {"type":"image/png","name":"image.png","off":0,"len":N}]}`; binary items are ranges of
    `bytes`. Ownership → engine. Bumps changeCount, does **not** notify the observer (host-sourced).
  - `bibChrome` kind `"clipboard"`: `{"items":[{"type","text"} | {"type","name","ptr","len"}]}`;
    binary items engine-malloc'd, JS frees (the favicon contract). Emitted by the observer;
    document it in the kinds list and drop `"caret"`-style reservation wording as appropriate.
- Smoke in the dev harness before touching the extension: `web/` harness + `Module.bibChrome`
  logging, `__bs.eval("document.execCommand('copy')")` after a selection → one signal with
  both text and markup.

### 2. Host: worker, link, viewer (~150 lines)

- **`engine-worker.js`**: message `{t:'clipboard-set', json, buf}` → two `bib_wasm_alloc`s +
  `_bib_clipboard_set`; chrome kind `"clipboard"`: copy each `ptr/len` out of the heap into one
  transferable buffer, free them, post `{t:'chrome', kind, json, buf}` (rewrite `ptr/len` to
  `off/len`). **`engine-link.mjs`**: `clipboardSet(json, bytes)`; `onChrome(kind, json, buf)`.
- **New `src/ext/clipboard.mjs`** (pure, tier-0 testable): `packDataTransfer(dt) → {json, bytes}`
  (text/plain, text/html, text/uri-list; `dt.files` images as bytes; size cap ~32 MB total,
  images dropped first), `toClipboardItems(json, buf)` → `[ClipboardItem]` (+ plain-text
  fallback string), and the two key predicates below.
- **`viewer.mjs` key routing** — the viewer holds no clipboard keybindings. It answers two
  questions per keydown, each a small predicate with a stated reason:
  1. *Does the host browser own this key?* (`hostKey`, a **deny list**, today's inverted
     whitelist): F5, Alt+←/→, Ctrl/Cmd+{L,T,W,N,R,Tab,digits,Shift+T}, F12/Ctrl+Shift+{I,J,C}.
     Not forwarded, not prevented. **Everything else is forwarded** — the nested page must
     receive what a normal page receives (Docs/Gmail need Ctrl+B/K/Enter, not just C/V), and
     the Ctrl/Meta bail-out was solving the wrong problem. The engine's key map (step 1)
     decides what a combo *means*; the viewer never does.
  2. *Do we rely on this key's host default action?* (`hostDefaultCarriesClipboard`): yes for
     the keys the host binds to paste — Ctrl/Cmd+V with any Shift, Shift+Insert. Every
     forwarded key is `preventDefault`ed (Ctrl+A must not select the viewer page, Ctrl+S must
     not open Save) **except** these, because a prevented keydown cancels the host's paste
     command and with it the `paste` event that carries the clipboard. This is the one place
     host keybinding knowledge lives, and it is inherent to reading the clipboard through the
     browser's gesture-gated event rather than taking `clipboardRead` (VS Code web and Figma
     make the same trade; Mac hosts send Meta, which is why the predicate is host-side).
  Ordering without a state machine: keys in set 2 are forwarded from a macrotask
  (`setTimeout(0)`) posted at keydown. The `paste` event is part of that key's default action
  in the same task, so its `link.clipboardSet(pack(e.clipboardData))` is always posted to the
  worker before the key; if the host fires no paste event for that key, the key simply arrives
  and the engine pastes what the store holds. No "did paste come?" bookkeeping, no fallback
  path. (Chrome schedules input tasks ahead of timers, so a mouse event landing within that
  ~0–1 ms could be processed first — human-scale impossible, and harmless if it happened.)
  Keyup is unaffected. `paste` listener: `preventDefault`, attached to the key-sink element.
- **`onChrome('clipboard')`**: write only if `performance.now() - lastCanvasInputAt < 5000`
  (mirrors transient activation; Chrome's auto-grant would otherwise let an owned engine write
  the clipboard from a timer — security.md); `navigator.clipboard.write(items)`, on rejection
  `writeText(plain)`, on rejection log once. Track `lastCanvasInputAt` in the existing
  mouse/key listeners.
- URL bar: untouched — it is a real `<input>`, native copy/paste already works there.

### 3. Tests

- **Fixture** `test/fixtures/pages/clipboard.html` on `clipboard.bstest` (hosts.mjs):
  `<p id=src>` with a plain word and a `<b>` word, `<input id=field>` (+ checksum zone like
  input.html), `<div id=rich contenteditable>`, and colour zones for: `paste` event seen +
  checksum of `getData('text/plain')`, `types` contains `text/html`, `files[0].type ===
  'image/png'` (+ size bucket), `navigator.clipboard.readText()` rejected with NotAllowedError,
  `navigator.clipboard.writeText` resolved (from a click handler), `execCommand('copy')` result.
- **Tier-0** `clipboard.test.mjs`: `hostKey` / `hostDefaultCarriesClipboard` over synthetic
  event objects (incl. Meta on Mac, Shift variants, a plain letter → forwarded + prevented);
  `packDataTransfer` over a fake DataTransfer (types, files, cap); `toClipboardItems` round trip.
  ABI mirror test stays green.
- **Tier-2 Chrome scenario "clipboard"** (real keys via puppeteer; on Linux Blink itself maps
  Ctrl+V/Shift+Insert to the paste command, so CDP-injected keys fire real paste events):
  1. dblclick the plain word, Ctrl+C; click `#field`, Ctrl+V → checksum zone = word. Proves
     engine→host→engine through the headless clipboard with no test-side clipboard access.
  2. select the `<b>` word, Ctrl+C, click `#rich`, Ctrl+V → zone "b element present".
     Ctrl+Shift+V → plain.
  3. click the "writeText" button in the guest, paste into `#field` → checksum matches.
  4. `#field`: type, Ctrl+A, Ctrl+X → field empty and the zone shows the cut text on paste.
  5. image: put a PNG on the host clipboard from the viewer page (`navigator.clipboard.write`
     under `context.overridePermissions(extOrigin, ['clipboard-read','clipboard-write'])`,
     or CDP `Browser.grantPermissions` if puppeteer refuses the extension origin), Ctrl+V in
     the guest → files zone.
  6. readText zone shows NotAllowedError; a `paste` handler that `preventDefault`s still reads
     the text (GitHub-style upload widgets).
  Assertions are pixel probes (`until`/`is`) plus `__bs.eval` where a value is easier.
- **Firefox tier-2**: `test/harness/firefox.mjs` has no input actions. Add `page.keys(seq)` /
  `page.click(x,y)` over BiDi `input.performActions` (~30 lines), then run steps 1 and 6 there —
  the platform risks (probe (a)/(b)) are Firefox's, so the subset must cover the text round
  trip. Image step optional.
- Manual smoke (not CI): GitHub comment box paste (text + screenshot), Wikipedia select+copy
  into the host, a Google search box paste.

### 4. Notes, accounting, cleanup

- `bib_abi.h` (done in step 1), security.md capability table: `bibChrome` row gains
  "`clipboard`: write the host clipboard — viewer gates on a ≤5 s-old canvas input; reads
  never originate from the engine (paste event only)"; the `bib_clipboard_set` direction is a
  host→engine input like keys, note it under sandbox→host sinks only if reviewers ask.
- rendering-input.md § Clipboard: replace the MVP bullet with this design (deny-list key
  routing + the one paste-key exemption and why, macrotask ordering, coalesced writes, what
  stays denied); § Keyboard: the "pass through browser-level combos" bullet becomes the deny
  list. extension-platform.md § Permissions
  draft: drop `clipboardRead`/`clipboardWrite` (or record why `clipboardWrite` had to come
  back). roadmap.md fast-follow 1: strike clipboard. testing.md fixture list + scenario numbers.
  open-questions #14 answers. engine-internals.md: one line that the async clipboard's generic
  index functions are routed under `__EMSCRIPTEN__` (re-bites on rebase).
- Issue: editing-key gaps + undo/redo (from step 1). Delete this plan.

## Not in v1 (decided, with the path)

- **DOM-initiated reads** (`navigator.clipboard.readText()/read()`, `execCommand('paste')`)
  outside a paste gesture: denied. Supporting them means `clipboardRead` (install warning
  "Read data you copy and paste") **and** a synchronous answer in `requestDOMPasteAccess`,
  which the worker cannot get from the main thread without SAB. The workable design is a
  **host mirror**: with the permission (make it `optional_permissions`, requested from the
  options page), the viewer reads the host clipboard on canvas focus / tab visibility and
  pushes it via `bib_clipboard_set`; then `setDOMPasteAccessRequestsEnabled(true)` +
  `GrantedForGesture` answers from the store. Everything in v1 stays as is.
- **Rich HTML through the async API** (`read()` → `getType('text/html')`) and WebKit's own
  image-fragment insertion on paste into contenteditable: both need a
  `WebContentReader` platform half (`readHTML`/`readImage`, `#if COCOA||GTK||WPE`; ~80 lines
  cribbed from `editing/glib/WebContentReaderGLib.cpp`). Sites that matter (GitHub, Slack-like
  editors) use the `paste` event + `files`, which v1 covers.
- **Context-menu copy** (links, images, "Copy" on a selection) — needs the viewer context menu
  (rendering-input.md, post-MVP). `write(PasteboardImage)` is wired so it lights up when the
  menu lands.
- **Linux primary selection / middle-click paste**, drag-and-drop (`ENABLE_DRAG_SUPPORT` is 0).

## Interaction with the other plans

No permission change, no DNR involvement. If probe (b) forces `clipboardWrite`, add it to the
tier-0 `manifest.test.mjs` permission set. The IME plan will move the key sink off
the canvas; step 2 keeps the paste listener element-agnostic for that reason.
