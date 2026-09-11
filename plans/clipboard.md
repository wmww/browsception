# Plan: clipboard (copy / cut / paste between the host clipboard and the nested page)

Companion of plans/text-input.md: that plan owns the host editable proxy (mirror textarea,
composition, OSK) and the key-routing function; this one owns the **pasteboard data path** and
the three clipboard **verbs**. They share one engine entry point, `bib_edit`. Either can land
first.

## Why

Nothing clipboard-shaped works today, for three independent reasons found 2026-09-10:

1. **The viewer forwards no Ctrl/Cmd combo at all** (`viewer.mjs` keydown: `if (e.ctrlKey ||
   e.metaKey || hostKey(e)) return;`). The comment says they "stay with the host browser", which
   is right for Ctrl+T/W/L/R and wrong for editing (Docs/Gmail need Ctrl+B/K/Enter too).
2. **The engine pasteboard is a stub**: `platform/emscripten/PasteboardEmscripten.cpp` (in the
   WebKit patch) returns empty from every read and drops every write.
3. **`navigator.clipboard` does not exist in guest pages**: `AsyncClipboardAPIEnabled` defaults
   false at the raw-WebCore layer (empty-defaults family, main.cpp), and the generic
   `Pasteboard::allPasteboardItemInfo` / `readString(index,…)` / `readBuffer(index,…)` that
   `Modules/async-clipboard` calls are `#if COCOA||GTK||WPE` → `nullopt` here.

Everything else in WebKit is platform-neutral and already compiled: `Editor::copy/cut/paste`,
the `copy`/`cut`/`paste` DOM events with `clipboardData` (`DataTransfer` over our
`Pasteboard`), `execCommand('copy')` under the default `ClipboardAccessPolicy::RequiresUserGesture`,
`Clipboard::writeText/write/readText/read`. The port runs WebKit's **legacy pasteboard path**
(`DeprecatedGlobalSettings::customPasteboardDataEnabled()` is false): reads are
`typesForLegacyUnsafeBindings()` + `readString(type)`, DOM `setData` commits arrive as `clear()`
followed by one `writeString(type, string)` per type, `Editor::copy` arrives as
`write(PasteboardWebContent{text, markup})` (`writePlainText` inside text controls), and
`Clipboard::writeText` as `writeCustomData` with one platform string. A small in-engine store
covers all of it.

## Design in one paragraph

The engine owns an in-memory **pasteboard store** (typed items: strings for text/plain,
text/html, text/uri-list; bytes for images; a change count). The host is the only thing that
talks to the real clipboard, in exactly two moments that browsers already gate for us. **The
verbs are ClipboardEvents, never keys**: the host browser decides what Ctrl+C, Cmd+V, Shift+Insert,
the Edit menu, an OSK toolbar button or a context menu *mean* on its own platform and tells us
by firing `copy`/`cut`/`paste` on the focused sink; the viewer turns each into one
`bib_edit` op — `paste` carries `clipboardData` (fresh, gesture-gated, no permission), so
WebKit's `Editor::paste` and the guest's `paste` event see the host clipboard; `copy`/`cut` run
`Editor::copy/cut`. Every store mutation the engine makes (a copy op, `execCommand('copy')`, a
`copy` handler's `setData`, `navigator.clipboard.writeText`) is coalesced into one
`bibChrome("clipboard")` signal, and the viewer writes it to the host clipboard with the async
Clipboard API, itself gated on a recent user input. No manifest permission, no clipboard key
map on either side. Guest `navigator.clipboard.readText()/read()` without a paste gesture is
**denied** (NotAllowedError, what a site sees when the user declines the prompt) — § Not in v1.

## Steps

### 0. Probe the host facts the design rests on (both browsers, ~1 h)

A throwaway page loaded as an *extension page* (a viewer-shaped `?stub=1` page is enough — the
origin is what matters), driven by real key presses (gui-testing skill; synthetic events carry
no activation). Record answers in open-questions.md as **#21** (14 is taken), then decide the
fallbacks below.

- (a) With a focused `<canvas tabindex=0>` and no selection or editable anywhere on the page: do
  Ctrl+C / Ctrl+X / Ctrl+V fire `copy` / `cut` / `paste` on the canvas, and is
  `paste.clipboardData` readable (`getData('text/plain'|'text/html')`, `.types`, `.files` with a
  copied PNG) without a prompt? Chrome is expected to fire all three regardless of selection
  (copy buttons rely on it); Firefox is the one to verify for `copy`/`cut` with a collapsed
  selection, and for `paste` on a non-editable target (Firefox ≥ 125's paste context-menu prompt
  is for `navigator.clipboard.read`, not the event).
  **Fallback if Firefox withholds any of them**: make the sink a hidden `<textarea>` that is
  `readonly` while nothing editable is focused — text-input.md's mirror, pulled forward as the
  single sink — and re-run (a) against it. Write every listener against "the sink element",
  never `canvas` by name, so the sink can change without touching this code.
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

### 1. Engine: store, pasteboard, verbs, ABI (C++; ~250 lines, mostly patch)

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
  `text/plain` (cribbed from libwpe; ours normalizes anyway, keep them honest).
- **Verbs** — `bib_edit(const char* json, const char* bytes, int len)` (shared with
  text-input.md; if this plan lands first it adds the export with these three ops): `{op:"copy"}`
  / `{op:"cut"}` → `editor().command("Copy"|"Cut").execute()` (they check `canCopy`, so a copy
  with no selection is a no-op — and a guest `copy` handler that `setData`s still runs);
  `{op:"paste", plain, items:[…]}` → `store.replace(items)` (bumps changeCount, does **not** notify
  the observer — host-sourced), then `command("Paste"|"PasteAsPlainText").execute()`, which
  dispatches the guest's `paste` event first and respects its `preventDefault`. Items:
  `{"type":"text/plain","text":"…"}`, `{"type":"image/png","name":"image.png","off":0,"len":N}`
  (ranges of `bytes`, ownership → engine).
- **Key map** (`BibPageClients.h` `commandForKeyDown`): **no clipboard entries.** Add only the
  keyboard-native ones, Ctrl *or* Meta (Mac hosts send Meta): A→`SelectAll`, Z→`Undo`,
  Y / Shift+Z→`Redo`. Undo/Redo will not work (`registerUndoStep` is empty, `canUndo` false) —
  file an issue with the other editing-key gaps (Ctrl+arrows/Backspace word ops, Shift+Home/End,
  PageUp/Down) rather than widen this plan. `requestDOMPasteAccess` stays `DeniedForGesture`.
- **Settings** (main.cpp next to the other empty-defaults fixes): `setAsyncClipboardAPIEnabled(true)`.
  Leave `JavaScriptCanAccessClipboard`/`DOMPasteAllowed`/`DOMPasteAccessRequestsEnabled` false:
  that is exactly "copy needs a gesture, DOM-initiated paste needs permission".
- **ABI** (`bib_abi.h`, mirror in `abi.mjs`): `bib_edit` + the op shapes above; `bibChrome` kind
  `"clipboard"`: `{"items":[{"type","text"} | {"type","name","ptr","len"}]}` — binary items
  engine-malloc'd, JS frees (the favicon contract). Emitted by the store observer; document it in
  the kinds list.
- Smoke in the dev harness before touching the extension: `web/` harness + `Module.bibChrome`
  logging, `__bs.eval("document.execCommand('copy')")` after a selection → one signal with
  both text and markup; `bib_edit('{"op":"paste","items":[…]}')` into a focused field.

### 2. Host: worker, link, viewer (~150 lines)

- **`engine-worker.js`**: message `{t:'edit', json, buf}` → `bib_wasm_alloc` for the string and
  the bytes + `_bib_edit`; chrome kind `"clipboard"`: copy each `ptr/len` out of the heap into
  one transferable buffer, free them, post `{t:'chrome', kind, json, buf}` (rewrite `ptr/len` to
  `off/len`). **`engine-link.mjs`**: `edit(json, bytes)`; `onChrome(kind, json, buf)`.
- **New `src/ext/clipboard.mjs`** (pure, tier-0 testable): `packDataTransfer(dt) → {json, bytes}`
  (text/plain, text/html, text/uri-list; `dt.files` images as bytes; size cap ~32 MB total,
  images dropped first), `toClipboardItems(json, buf)` → `[ClipboardItem]` (+ plain-text
  fallback string), and `hostClipboardKey(e)` below.
- **Verb listeners** on the sink element (canvas today; the mirror when text-input.md lands —
  attach through one `sink` variable, or on a common ancestor with a target check):
  `copy` → `preventDefault`, `link.edit({op:'copy'})`; `cut` → same with `cut`; `paste` →
  `preventDefault`, `link.edit({op:'paste', plain, ...packDataTransfer(e.clipboardData)})`.
  `plain` is the one key-shaped fact left: ClipboardEvent carries no modifiers, so the viewer
  remembers whether the keydown in the *same task* (if any) had Shift held — the "paste as plain
  text" convention on every platform. No key ordering trick is needed: the keydown that caused
  the event is posted from its own listener before the verb, and the engine has no binding for
  it, so the guest sees keydown then `paste` in the natural order.
- **Key routing** — the viewer holds no clipboard keybindings and forwards *everything* the host
  does not own. Two predicates, each with a stated reason (text-input.md folds them into its
  `routeKey`; until then they replace the Ctrl/Meta bail-out in the keydown listener):
  1. `hostKey(e)` — the host owns this key (a **deny list**, today's inverted whitelist): F5,
     Alt+←/→, Ctrl/Cmd+{L,T,W,N,R,Tab,digits,Shift+T}, F12/Ctrl+Shift+{I,J,C}. Not forwarded,
     not prevented. Everything else is forwarded — the nested page must receive what a normal
     page receives; the engine's key map decides what a combo *means*, the viewer never does.
  2. `hostClipboardKey(e)` — keys whose host default action is the clipboard command we consume:
     Ctrl/Cmd+{C,X,V} with any Shift, Ctrl+Insert, Shift+Insert, Shift+Delete. Forwarded like any
     key, but **not prevented**, because a prevented keydown cancels the host's copy/paste
     command and with it the event that carries the clipboard. This is the one place host
     keybinding knowledge lives, it is host-side (Mac sends Meta), and it is inherent to
     reading the clipboard through the browser's gesture-gated event instead of taking
     `clipboardRead` — VS Code web and Figma make the same trade. Every other forwarded key is
     prevented (Ctrl+A must not select the viewer page, Ctrl+S must not open Save).
- **`onChrome('clipboard')`**: write only if `performance.now() - lastSinkInputAt < 5000`
  (mirrors transient activation; Chrome's auto-grant would otherwise let an owned engine write
  the clipboard from a timer — security.md); `navigator.clipboard.write(items)`, on rejection
  `writeText(plain)`, on rejection log once. Track `lastSinkInputAt` in the existing mouse/key
  listeners.
- URL bar: untouched — it is a real `<input>`, native copy/paste already works there.

### 3. Tests

- **Fixture** `test/fixtures/pages/clipboard.html` on `clipboard.bstest` (hosts.mjs):
  `<p id=src>` with a plain word and a `<b>` word, `<input id=field>` (+ checksum zone like
  input.html), `<div id=rich contenteditable>`, and colour zones for: `paste` event seen +
  checksum of `getData('text/plain')`, `types` contains `text/html`, `files[0].type ===
  'image/png'` (+ size bucket), `navigator.clipboard.readText()` rejected with NotAllowedError,
  `navigator.clipboard.writeText` resolved (from a click handler), `execCommand('copy')` result,
  and a `#nopaste` field whose `paste` handler `preventDefault`s.
- **Tier-0** `clipboard.test.mjs`: `hostKey` / `hostClipboardKey` over synthetic event objects
  (incl. Meta on Mac, Shift variants, a plain letter → forwarded + prevented); `packDataTransfer`
  over a fake DataTransfer (types, files, cap); `toClipboardItems` round trip; the same-task
  Shift memory. ABI mirror test stays green.
- **Tier-2 Chrome scenario "clipboard"** (real keys via puppeteer; on Linux Blink itself maps
  Ctrl+C/V and Shift+Insert to the clipboard commands, so CDP-injected keys fire real events):
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
  6. readText zone shows NotAllowedError; `#nopaste` still reads the text but stays empty
     (GitHub-style upload widgets).
  7. **key-less paste**: from `page.evaluate`, dispatch `new ClipboardEvent('paste',
     {clipboardData: dt})` with a `DataTransfer` holding text on the sink → the field receives
     it. This is the OSK-toolbar / Edit-menu path, and the proof that no key is involved.
  Assertions are pixel probes (`until`/`is`) plus `__bs.eval` where a value is easier.
- **Firefox tier-2**: `test/harness/firefox.mjs` has no input actions. Add `page.keys(seq)` /
  `page.click(x,y)` over BiDi `input.performActions` (~30 lines), then run steps 1, 6 and 7
  there — the platform risks (probe (a)/(b)) are Firefox's, so the subset must cover the text
  round trip. Image step optional.
- Manual smoke (not CI): GitHub comment box paste (text + screenshot), Wikipedia select+copy
  into the host, a Google search box paste; on macOS, Edit ▸ Paste from the menu bar.

### 4. Notes, accounting, cleanup

- `bib_abi.h` (done in step 1), security.md capability table: `bibChrome` row gains
  "`clipboard`: write the host clipboard — viewer gates on a ≤5 s-old sink input; reads
  never originate from the engine (paste event only)"; `bib_edit` is a host→engine input like
  keys, note it under sandbox→host sinks only if reviewers ask.
- rendering-input.md § Clipboard: replace the MVP bullet with this design (verbs are
  ClipboardEvents, the two routing predicates and why, coalesced writes, what stays denied);
  § Keyboard: the "pass through browser-level combos" bullet becomes the deny list.
  extension-platform.md § Permissions: drop `clipboardRead`/`clipboardWrite` from the
  "features that would add permissions" line (or record why `clipboardWrite` had to come
  back). roadmap.md fast-follow 1: strike clipboard. testing.md fixture list + scenario numbers.
  open-questions #21 answers. engine-internals.md: one line that the async clipboard's generic
  index functions are routed under `__EMSCRIPTEN__` (re-bites on rebase).
- Issue: editing-key gaps + undo/redo (from step 1). Delete this plan.

## Not in v1 (decided, with the path)

- **DOM-initiated reads** (`navigator.clipboard.readText()/read()`, `execCommand('paste')`)
  outside a paste gesture: denied. Supporting them means `clipboardRead` (install warning
  "Read data you copy and paste") **and** a synchronous answer in `requestDOMPasteAccess`,
  which the worker cannot get from the main thread without SAB. The workable design is a
  **host mirror**: with the permission (make it `optional_permissions`, requested from the
  options page), the viewer reads the host clipboard on sink focus / tab visibility and pushes
  it via a `{op:"clipboard-set"}` edit op; then `setDOMPasteAccessRequestsEnabled(true)` +
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
tier-0 `manifest.test.mjs` permission set. text-input.md moves the sink to its mirror textarea
and absorbs the two key predicates into `routeKey`; the verb listeners are written against the
sink so that is a one-line change. If probe (a) fails on Firefox, the mirror comes first.
