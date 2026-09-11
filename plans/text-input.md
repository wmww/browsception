# Plan: text input — a host editable proxy for IME, on-screen keyboards, and clipboard verbs

## Why

Typing works today only for keys that carry their own character: the viewer forwards
`keydown/keyup` (+ a CHAR event when `e.key.length === 1`) and `BibEditorClient` maps them to
editor commands. Everything that is not "one physical key = one character" is missing:

- **Composition** — dead keys (Option+e, US-intl `'` + `e`), every desktop IME (CJK, Vietnamese),
  and macOS accent popups produce `key: 'Dead'`/`'Process'`, keyCode 229 and
  `composition*` events. The viewer drops all of it (`key.length !== 1`).
- **On-screen keyboards** — a touch host (Firefox Android is the one shipping extension host
  with an OSK; Windows/ChromeOS touch laptops are the other case) shows a keyboard only when a
  *real editable DOM element* is focused, and needs its surrounding text and content type to
  autocorrect, suggest, swipe, move the cursor, and pick the layout. A canvas can never say "a
  text field is focused". Gboard also sends most input as composition + `beforeinput` with
  keydown 229, not as keys.
- **Clipboard verbs from non-key sources** — OSK toolbar Paste, the host's Edit menu on macOS,
  context-menu Paste in the URL bar's sibling, Firefox's paste prompt: all arrive as
  `copy`/`cut`/`paste` *events*, never as keys.
- **The engine cannot tell the host anything about the focused field** (no caret rect, no
  editability, no content type), so the host has nothing to put an IME candidate window next to
  and no way to scroll the field above an OSK.

This is roadmap fast-follow 2 ("IME/composition via hidden-input-at-caret") generalized, and it
is the frame the clipboard (landed 2026-09-10, notes/rendering-input.md § Clipboard) sits in.

## The shape: the Wayland text-input dance, one hop up

Wayland's `zwp_text_input_v3` is the right mental model. The engine is the toolkit; the viewer is
the compositor's input method; the host browser (and through it the OS IME / OSK) is the IM.

| text-input-v3 (client → IM) | ours (engine → viewer, `bibChrome("editor")`) |
|---|---|
| `enable` / `disable` | `editable: true/false` (focused element `shouldUseInputMethod()`) |
| `set_surrounding_text(text, cursor, anchor)` | `text` window (≤ 2k chars each side of the selection), `selStart`, `selEnd`, `window` (char offset of the window start in the editable root) |
| `set_content_type(hint, purpose)` | `inputmode`, `enterkeyhint`, `autocapitalize`, `spellcheck`, `password`, `lang`, `dir` |
| `set_cursor_rectangle` | `caret: [x, y, w, h]` device px (post-layout) |
| `commit` (batch marker) | one signal per `bib_tick`, only when something changed |

| text-input-v3 (IM → client) | ours (viewer → engine, `bib_edit(json, bytes, len)`) |
|---|---|
| `preedit_string(text, cursor_begin, cursor_end)` | `{op:"composition", text, selStart, selEnd}` → `Editor::setComposition` |
| `commit_string(text)` | `{op:"commit", text}` → `Editor::confirmComposition(text)` (inserts when there is no composition) |
| `delete_surrounding_text(before, after)` | `{op:"delete", before, after}` (caret-relative, chars) → `WebPage::deleteSurrounding` crib |
| — (IM cannot move the cursor) | `{op:"select", start, end, base}` window-relative, dropped when `base` ≠ the engine's last emitted `seq` |
| — | `{op:"copy"|"cut"}` / `{op:"paste", items, plain}` (landed with the clipboard) |

The host side of the dance is what every canvas-rendered editor does (VS Code's
`TextAreaInput`, Figma, Google Docs since 2021): a hidden real `<textarea>` — the **mirror** —
positioned at the caret, focused exactly when the engine has an editable focused, holding the
surrounding text and selection, carrying the content-type attributes. The host browser runs its
IME/OSK/autocorrect/dictation against the mirror as if it were the page's field; the viewer
turns what happened to the mirror back into the ops above. Chrome-on-Android's own IME adapter
is the same design across a process boundary (browser process ↔ renderer), with the same
asynchrony we have (worker, no SAB), so the sync rules below are its rules.

**Keys stay keys.** Physical `keydown/keyup` are forwarded and `preventDefault`ed as today and
the engine's editor performs their default actions, so a guest `keydown` handler that
`preventDefault`s still suppresses the insertion (input masks, in-guest editors). The mirror is
the source of truth only for what *does not arrive as a key*: composition, IME/OSK commits,
autocorrect replacements, and the clipboard verbs. The two never overlap because a prevented
keydown has no default action on the mirror, and IME-handled keys (below) are the ones we do
not prevent.

## Design

### Engine: editor state out, ops in (~300 lines embedder, ~10 lines patch)

- **State** — `BibEditorClient` sets `g_editorStateDirty` from `respondToChangedSelection`,
  `respondToChangedContents`, `setInputMethodState` (FocusController calls it on every focus
  change), `didUpdateComposition`, `canceledComposition/discardedComposition`. `bib_tick`, after
  `Page::updateRendering` (layout is clean there — WebKit2 calls this "post-layout data"),
  computes the state, compares with the last one sent, and `emitChrome("editor", …)` on change:
  `{seq, editable, text, window, selStart, selEnd, compStart, compEnd, caret, inputmode,
  enterkeyhint, autocapitalize, spellcheck, password, lang, dir}`.
  - `editable` = focused element && `shouldUseInputMethod()` && frame focused. Password fields
    are `editable` with `password: true` and an **empty** `text` — secrets never enter the host
    DOM; the OSK does not need them.
  - Surrounding text: crib `WebPage::getPlatformEditorState` (glib) — `startOfEditableContent`
    / `endOfEditableContent` around `selection.visibleStart()`, `plainText` on the ranges,
    `characterCount` for offsets, the composition range excised like glib does. Clip to a window
    of 2k chars each side via `resolveCharacterRange` before calling `plainText` (cost is one
    TextIterator walk from the editable root per change, same as WPE; the cap keeps huge
    contenteditables from shipping megabytes per keystroke). `window` = chars from the root to
    the window start.
  - `caret` = `selection().absoluteCaretBounds()` (focus end for ranges), logical → device px
    (× dpr — the ABI's unit, the inverse of `bibLogicalPoint`).
  - Content type: `HTMLElement::canonicalInputMode()`, `enterKeyHint()`, `autocapitalizeType()`,
    `isSpellCheckingEnabled()`, `HTMLInputElement::isPasswordField()`, `effectiveLang()`,
    computed `direction`.
  - `seq` = the highest `bib_edit` seq applied so far (0 before any). Every state carries it,
    including states caused by guest JS, so the viewer can tell "reflects my last op" from
    "older than my last op".
- **Ops** — `bib_edit(const char* json, const char* bytes, int len)`, proxied like `bib_key`,
  `{seq, op, …}`. Applied to `focusController().focusedOrMainFrame()->editor()`:
  `composition` → `setComposition(text, {one underline}, {}, {}, selStart, selEnd)`;
  `commit` → `confirmComposition(text)`; `delete` → the `WebPage::deleteSurrounding` recipe
  (before) + a forward variant (after), both via `resolveCharacterRange` on the editable root;
  `select` → `resolveCharacterRange(root, {window + start, end - start})` → `setSelection`,
  skipped when `base != lastEmittedSeq`; `copy`/`cut`/`paste` exist (`BibClipboard.h`). Every op bumps
  `seq` and dirties the state. Ops with no editable focused (composition after focus moved) are
  dropped, not errors.
- **IME-handled keys** need nothing engine-side: the viewer forwards them as they arrive
  (`key` `'Process'`/`'Dead'`/the raw key, `keyCode` 229, **no CHAR**), nothing in the key map
  matches them, so the editor inserts nothing and the guest sees the same keydown a real
  browser shows during composition. `handleInputMethodKeydown` stays empty.
- **ABI** — `bib_abi.h`: `bib_edit`, `bibChrome` kind `"editor"` replacing the reserved
  `"caret"`. `abi.mjs` mirror + tier-0 `abi.test.mjs`.

### Viewer: the mirror and the input controller (`src/ext/text-input.mjs`, pure; ~350 lines)

- **Two sinks, focus follows the engine.** The canvas stays the sink when nothing editable is
  focused in the engine (keys only, no OSK). When a state arrives with `editable: true` the
  viewer focuses the mirror (`focus({preventScroll: true})`); `editable: false` refocuses the
  canvas. A focus *change* is what raises an OSK on every platform; the `Element.focus()` call
  lands ~10–50 ms after the tap that caused it, inside Chrome's transient-activation window and
  Gecko's `IsHandlingUserInput` grace (1 s) — probe (b) checks both hosts. Both sinks live in
  the canvas box; `bib_set_focus` moves from the canvas's focus/blur to the box's
  `focusin`/`focusout`, ignoring a `focusout` whose `relatedTarget` is inside the box — so the
  hop is invisible to the guest. The clipboard listeners are on `document`, gated on the canvas
  being `activeElement` (viewer.mjs `sinkFocused`) — widen that gate to "either sink".
- **Mirror** — `<textarea id=sink>` inside the canvas box, `position:absolute`, 1 × line-height,
  `opacity:0`, `resize:none`, `autocomplete=off`, `tabindex=-1`, moved to `caret` (device →
  CSS px by the live backing/CSS ratio, clamped into the canvas rect — an owned engine may not
  place it outside). Attributes set from the state: `inputmode`, `enterkeyhint`,
  `autocapitalize`, `spellcheck`, `lang`, `dir`. A textarea, not contenteditable: one text node,
  `selectionStart/End`, `setRangeText`, and it is what VS Code ships on every OSK.
- **Applying a state to the mirror** — write `value` + selection only if (1) no host composition
  is in progress (writing to a composing textarea cancels the composition — VS Code's rule) and
  (2) `state.seq === lastSentSeq` (a state older than our last op would revert the user's typing:
  the classic cursor-jump bug). Stale states are kept as `pending` and applied when the next
  qualifying one arrives or composition ends.
- **Turning mirror changes into ops** — *the diff is the protocol*, VS Code's
  `TextAreaState.deduceInput` shape: on `input` (not composing) and on
  `compositionupdate`/`compositionend`, compare the previous mirror state (value, selection) with
  the new one, strip common prefix/suffix relative to the old selection, emit
  `delete{before,after}` + `commit{text}` (or `composition{text,…}` while composing). Diffing
  is what survives every IME and OSK; `beforeinput.inputType` is consulted only to *ignore*
  `insertFromPaste`/`insertFromDrop` (the paste event owns those) and
  `historyUndo/Redo` (Undo/Redo commands; plans/keyboard-keys.md makes them live). Selection-only changes
  on the mirror (`selectionchange`, e.g. Gboard's spacebar cursor slide) → `select`.
- **Key routing** (one function, `routeKey(e)`, replaces today's early-returns):
  1. `hostKey(e)` — src/ext/keys.mjs (landed). Not forwarded, not prevented.
  2. `imeKey(e)` — `e.isComposing || e.keyCode === 229 || e.key === 'Process' || e.key === 'Dead'`.
     Forwarded as-is, no CHAR, **not prevented** (the host must run its composition on the
     mirror).
  3. `hostPasteKey(e)` — keys.mjs. Forwarded, not prevented.
  4. Everything else: forwarded (+ CHAR per `keyText`), prevented.
- **OSK geometry** — append `interactive-widget=resizes-content` to the viewport meta
  touch-input.md adds, so an OSK shrinks the *layout* viewport (Chrome ≥ 108 defaults to resizing only the visual
  viewport, which would leave the canvas half covered and fire no `ResizeObserver`). The existing
  resize path then shrinks the engine viewport and WebCore's own `revealSelection` scrolls the
  caret into view. Fallback for a host without `interactive-widget` (probe (d)): set the canvas
  height from `visualViewport.height` on its `resize`.

### Probes (throwaway extension page + real input; record in open-questions.md as #22)

- (a) Desktop composition on the mirror: Firefox/Chrome Linux with ibus-pinyin or a dead-key
  layout, and macOS Option+e — does the `keydown` we leave unprevented start composition on a
  1-px `opacity:0` textarea, and do `compositionupdate` values + `input` diffs reconstruct the
  text? Expected yes (VS Code does this); the value of the probe is a **recorded event trace**
  per IME (a `?stub=1` page that logs every key/composition/input/selection event with the
  textarea state) — those traces become the tier-0 fixtures for the diff.
- (b) OSK show timing: on Firefox Android (`web-ext run -t firefox-android`) and a Windows/ChromeOS
  touch host, does `textarea.focus()` from a task ~50 ms after the tap raise the keyboard? Gboard
  trace for a word + space + backspace + swipe (expected: keydown 229, composition per word,
  real `Backspace` keydown outside composition). If focus-after-roundtrip does not raise the OSK:
  the fallback is engine-published **editable rects** (visible text controls' bounds, updated
  with layout) so the tap handler can focus the mirror synchronously on a predicted hit and the
  engine's answer corrects a miss. Budget it only if the probe fails.
- (c) `inputmode`/`enterkeyhint`/`autocapitalize`/`spellcheck` on the mirror change the OSK on
  Firefox Android as they do for a page field (expected yes — GeckoView reads them off the
  focused element).
- (d) `interactive-widget=resizes-content` honoured by Firefox Android? If not, the
  `visualViewport` fallback above.

### Tests

- **Tier-0** `text-input.test.mjs`: `routeKey` over synthetic events (Dead, Process, 229,
  isComposing, plain letter, host keys, Mac Meta); the diff over the recorded traces from probe
  (a)/(b) (each trace = event list + expected op list); state→mirror application rules (composing
  → deferred; stale seq → deferred; password → empty value).
- **Fixture** `text-input.bstest`: `<input>` (checksum zone as input.html), `<textarea>`,
  `<div contenteditable>`, `<input type=password>`, `<input inputmode=numeric enterkeyhint=go>`,
  a readonly input, and zones for: last `keydown.keyCode` (229 during composition),
  `compositionstart/update/end` counts, last `input.inputType`, `isComposing` on keydown.
- **Tier-2 Chrome** (CDP drives real IME paths into the focused mirror — no OSK needed):
  1. click `#field`, `Input.imeSetComposition('n', 0, 1)`, `('ni', 0, 2)`, `Input.insertText('你')`
     → checksum zone = 你, composition zones = 1/2/1, keyCode zone = 229 on the composing keydown.
  2. `page.keyboard.sendCharacter('é')` (Input.insertText: a key-less commit, what an OSK does)
     into `#field` and into `#rich` → checksum / text zone.
  3. type `hello`, then dead-key sequence via `Input.dispatchKeyEvent` (`key: 'Dead'`) +
     `imeSetComposition` → `hellö`.
  4. focus follow: click `#field` → viewer `document.activeElement` is the mirror with
     `inputMode` `''`, `value` mirroring the field, selection at the caret, `style.left/top`
     within the field's rect; click `#numeric` → `inputMode === 'numeric'`,
     `enterKeyHint === 'go'`; click `#password` → `value === ''`; click the readonly input and the
     page body → activeElement is the canvas.
  5. guest `keydown` `preventDefault` on `#masked` (fixture: digits only) — type `a1` → checksum
     `1` (keys-stay-keys invariant).
  6. `Backspace` via the mirror path: `imeSetComposition('ab')`, then a synthetic
     `beforeinput`/`input` with `inputType: 'deleteContentBackward'` on the mirror (dispatch from
     `page.evaluate` — the diff, not the key, must delete) → `a`.
  7. resize: shrink the window height by 300 px with `#field` focused near the bottom → the
     engine viewport shrinks and the caret rect stays inside the canvas (the OSK case without an
     OSK).
- **Firefox tier-2**: run 4 and 5 there. BiDi input refuses extension pages; the harness's
  `page.press/type` synthesize trusted keys from the chrome window (testing.md § Launch recipes),
  and there is no mouse — focus fields through fixture hooks. The same `nsITextInputProcessor`
  can drive composition (`setPendingCompositionString`/`flushPendingComposition`/
  `commitComposition`), so composition may be testable on Firefox after all.
- **Manual**: Firefox Android on a phone (gui-testing has no touch): Wikipedia search box with
  Gboard — suggestions, swipe, backspace, Go; a GitHub comment; a password login.

### Notes and accounting

- `bib_abi.h` (in the steps), security.md capability table: `bibChrome` row gains
  `editor`: "positions/attributes an invisible host textarea (clipped into the canvas) and
  focuses it — may raise the host's OSK/IME; puts the field's surrounding text in the host DOM,
  which the host IME may see, same as any page field; never for password fields". `bib_edit`
  is host→engine input like keys; paste payload only ever originates from a paste event.
- rendering-input.md: § IME/composition and § Keyboard replaced by this design (the routing
  function, the two sinks, the sync rules); § Touch gets the OSK viewport note.
  roadmap.md fast-follow 2 struck. Delete this plan; distil the sync rules into
  rendering-input.md.

## Order and dependencies

1. **Stage A — desktop composition** (engine state + ops + mirror + routing; Chrome/Firefox
   desktop). `bib_edit` exists (clipboard ops); this extends the op set and the key routing.
   Fixes dead keys and desktop IMEs, which are broken for every non-US-ASCII typist today.
2. ~~Stage B — clipboard verbs~~ landed 2026-09-10.
3. **Stage C — touch hosts**: probes (b)–(d), the `interactive-widget` viewport addition, the
   Firefox Android smoke. Prerequisite: plans/touch-input.md (pointer events, drag-to-scroll,
   fling) — today a phone gets synthesized taps and no scrolling, so it cannot reach a field to
   type into. Do that plan before stage C, not inside it.

## Not in this plan

- Selection handles / long-press select on touch; the engine's own context menu.
- Undo/redo (`registerUndoStep` empty), Ctrl+arrow word ops, Shift+Home/End, PageUp/Down in the
  key map — plans/keyboard-keys.md.
- Spellcheck inside the engine (`TextCheckerClient` stubs; the host's spellcheck on the mirror is
  turned off — it would underline invisible text and its context menu is unreachable).
- macOS press-and-hold accent popups on physical keys: they need the keydown unprevented, which
  would double-insert; VS Code has the same limitation.
- Accessibility (screen readers read the mirror, not the page) — a separate, larger topic.
