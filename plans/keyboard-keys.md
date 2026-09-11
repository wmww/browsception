# Keyboard: scroll keys, editing chords, undo/redo

Replaces issues/keyboard-scroll-keys.md and issues/editing-key-gaps.md (2026-09-11). One plan
because the three defects share one pipeline: viewer `keydown` → `bib_key` → WebCore
`EventHandler::keyEvent` → `BibEditorClient::handleKeyboardEvent` (our key map) → WebCore's
default key handlers.

## What's broken

1. **Nothing scrolls from the keyboard except Space.** On any page with `body` focused,
   ↑/↓/←/→, PageUp/PageDown, Home/End leave `scrollY` unchanged (verified on `scroll.bstest`
   and tumblr). Tab doesn't move focus either — same cause.
2. **Editing chords are missing.** The key map binds only Backspace/Delete, plain arrows,
   Shift+←/→, Home/End and the clipboard verbs. Ctrl+←/→ and Ctrl+Backspace/Delete act on one
   character; Shift+Home/End and Shift+↑/↓ don't extend; Ctrl+Home/End, PageUp/Down in a
   textarea, and every Mac chord (Cmd+←/→/↑/↓, Alt+←/→, Cmd/Alt+Backspace) do nothing.
3. **Undo/redo is dead everywhere WebCore edits.** `BibEditorClient::registerUndoStep` is
   empty and `canUndo()` returns false, so Ctrl+Z, `execCommand('undo')` and
   `queryCommandEnabled('undo')` are all no-ops. Guest editors with their own undo (Docs,
   CodeMirror) work because they see the keydown.

## Causes (all ours)

- `bib_key` (main.cpp:1974) constructs `PlatformKeyboardEvent` with `keyIdentifier =
  emptyString()`. WebCore's keydown defaults dispatch on that legacy identifier
  (EventHandler.cpp ~L4510: `"U+0009"` → tab focus, `"PageUp"/"PageDown"`, `"Home"/"End"`,
  `focusDirectionForKey` wants `"Up"/"Down"/"Left"/"Right"`). Space works only because it is
  handled on keypress via `charCode`, and Escape because it reads `key()`.
- `EventHandler::defaultPageUpDownEventHandler` / `defaultHomeEndEventHandler` bodies are
  `#if PLATFORM(GTK) || PLATFORM(WPE) || PLATFORM(WIN)` (EventHandler.cpp L4969, L4985). We
  build PORT=Emscripten, so they compile to `UNUSED_PARAM`. Arrows are not gated (the
  identifier alone fixes them).
- `commandForKeyDown` (BibPageClients.h:451) is a hand-written if-chain, not a table, and the
  editor client has no undo stacks.

Verified while reading, so the implementer need not re-derive it:
- Move commands are `enabledInEditableTextOrCaretBrowsing` (EditorCommand.cpp ~L1724), so
  outside editable content `Command::execute` returns false and the key falls through to the
  scroll defaults. `*AndModifySelection` are `enabledVisibleSelection…`: Shift+arrows extend a
  range selection on a non-editable page, which is what real browsers do.
- `EventHandlerDrivenSmoothKeyboardScrollingEnabled` and `ScrollAnimatorEnabled` default to
  false for WebCore, so keyboard scrolling takes the synchronous `logicalScrollRecursively`
  jump, the same path Space already takes. No animator or keyup bookkeeping involved.
- Editing behaviour is `EditingBehaviorType::Unix` under `OS(UNIX)` (Settings.yaml L104), and
  `shouldNavigateBackOnBackspace()` is `m_type != Unix`, so filling the identifier will NOT
  make Backspace navigate back. Step 6 asserts it anyway.
- Undo bookkeeping is entirely WebCore-side: `Editor::appliedEditing` calls
  `registerUndoStep(composition)` once per top-level command (typing coalesces into one open
  `TypingCommand`), `unappliedEditing` calls `registerRedoStep`, `reappliedEditing` calls
  `registerUndoStep` again, and `FrameLoader` calls `clearUndoRedoOperations` on navigation.
  The client only has to own two stacks. `UndoStep` (editing/UndoStep.h) is `unapply()`,
  `reapply()`, `label()`, `didRemoveFromUndoManager()`.

## Design decisions

- **Platform-free key map.** The viewer never says "this is a Mac". It doesn't need to: Ctrl
  chords are PC, Meta chords only come from Mac hosts (Cmd), and Alt+arrows only reach the
  engine from Mac hosts because on PC hosts they are host history keys (`hostKey`). So one
  table with Ctrl rows (PC word/document ops), Meta rows (Mac line/document ops) and Alt rows
  (Mac word ops) is correct on both, with no flag through the ABI. Ctrl+←/→ never arrives on
  a Mac (Mission Control grabs it), so the Ctrl rows can't misfire there.
- **Match on the Windows virtual key code**, like the WPE and WinCairo tables
  (`WebEditorClientWPE.cpp`, `WebPageWin.cpp` `keyDownEntries`). The viewer already sends
  `e.keyCode` as `windowsVirtualKeyCode`; letters match on non-Latin layouts, and the clipboard
  rows already work this way. Constants come from `<WebCore/WindowsKeyboardCodes.h>`.
- **keyIdentifier is derived in the embedder** (main.cpp) from the DOM `key` the viewer
  already sends, not in the WebKit patch: embedder-only edits rebuild in ~90 s. The two
  `#if PLATFORM(...)` hunks are unavoidable patch changes; keep them to exactly that.
- **Undo stacks live in `BibEditorClient`** with NSUndoManager semantics: a new undo step
  registered while not undoing/redoing clears the redo stack (Chrome/Safari behaviour;
  WebKit's `DefaultUndoController` doesn't, but it sits behind a UI that does). Capped at
  100 steps; evicted and cleared steps get `didRemoveFromUndoManager()` (CustomUndoStep
  invalidates its `UndoItem` on it).
- **The engine performs the defaults, never the viewer**, so guest `preventDefault` on keydown
  keeps working for every key here (the text-input plan relies on the same rule).

## Steps

Do 1–4 on one branch; each is testable alone, but the scenario in step 6 wants all of them.

### 1. keyIdentifier (main.cpp, embedder only)

Add next to `modifiersFromBits`:

```cpp
// WebKit's legacy DOM keyIdentifier, which EventHandler's keydown defaults
// dispatch on (tab focus, page/home/end/arrow scrolling). Same identifier
// set as PlatformKeyboardEvent::keyIdentifierForWPEKeyCode, keyed by the
// DOM `key` name the viewer sends. Empty for Char events, as every port
// clears it there (disambiguateKeyDownEvent).
static String keyIdentifierForKey(const String& key)
{
    if (key == "ArrowUp"_s) return "Up"_s;
    if (key == "ArrowDown"_s) return "Down"_s;
    if (key == "ArrowLeft"_s) return "Left"_s;
    if (key == "ArrowRight"_s) return "Right"_s;
    if (key == "Tab"_s) return "U+0009"_s;
    if (key == "Backspace"_s) return "U+0008"_s;
    if (key == "Delete"_s) return "U+007F"_s;
    if (key == "Escape"_s) return "U+001B"_s;
    // Single code point (letters, digits, space, punctuation): "U+%04X" of the
    // upper-cased code point, e.g. " " → U+0020, "a" → U+0041.
    if (auto cp = singleCodePoint(key)) return makeString("U+"_s, hex(toUpper(*cp), 4));
    // Named keys WebKit spells the same way: PageUp, PageDown, Home, End,
    // Enter, Insert, Clear, Help, F1..F24, Alt, Control, Shift, Meta,
    // CapsLock, NumLock, Pause, PrintScreen, … Pass through.
    return key;
}
```

Pass it as the 6th constructor argument for RawKeyDown and KeyUp; keep `emptyString()` for
Char. Expected consequences to check by hand before writing tests: Tab / Shift+Tab move
focus (currently dead outside `designMode`); Backspace on `body` does nothing (Unix editing
behaviour); Escape unchanged.

### 2. Open the two scroll defaults for the port (WebKit patch)

`bash scripts/build-engine.sh --sync-webkit` to own the tree, then in
`Source/WebCore/page/EventHandler.cpp` change both guards (L4969 in
`defaultPageUpDownEventHandler`, L4985 in `defaultHomeEndEventHandler`) to

```cpp
#if PLATFORM(GTK) || PLATFORM(WPE) || PLATFORM(WIN) || defined(__EMSCRIPTEN__)
```

`defined(__EMSCRIPTEN__)` is the spelling the patch already uses (43 sites, e.g. the
`ScrollAnimator::scrollAnimationEnabled` hunk); there is no `PLATFORM(EMSCRIPTEN)`. Build,
let the pre-build export capture the hunk into `engine/WebkitWasm/src/patches/
webkit-emscripten.patch`, stage. One WebCore TU plus link. Note the hunk in the WebKit-patch
section of notes/engine-build.md as a port-enablement change (not an upstream backport).

### 3. Key map as a table (BibPageClients.h)

Replace the if-chain in `commandForKeyDown` with a WPE-style table matched on
`(windowsVirtualKeyCode, exact modifier set)`. Modifier mask: Ctrl, Shift, Alt, Meta. Rows:

| Key | none | Shift | Ctrl | Ctrl+Shift | Alt (Mac) | Alt+Shift | Meta (Mac) | Meta+Shift |
|---|---|---|---|---|---|---|---|---|
| ← | MoveLeft | MoveLeftAndModifySelection | MoveWordLeft | MoveWordLeftAndModifySelection | MoveWordLeft | MoveWordLeftAndModifySelection | MoveToBeginningOfLine | MoveToBeginningOfLineAndModifySelection |
| → | MoveRight | MoveRightAndModifySelection | MoveWordRight | MoveWordRightAndModifySelection | MoveWordRight | MoveWordRightAndModifySelection | MoveToEndOfLine | MoveToEndOfLineAndModifySelection |
| ↑ | MoveUp | MoveUpAndModifySelection | — | MoveParagraphBackwardAndModifySelection | — | MoveParagraphBackwardAndModifySelection | MoveToBeginningOfDocument | MoveToBeginningOfDocumentAndModifySelection |
| ↓ | MoveDown | MoveDownAndModifySelection | — | MoveParagraphForwardAndModifySelection | — | MoveParagraphForwardAndModifySelection | MoveToEndOfDocument | MoveToEndOfDocumentAndModifySelection |
| PageUp | MovePageUp | MovePageUpAndModifySelection | | | | | | |
| PageDown | MovePageDown | MovePageDownAndModifySelection | | | | | | |
| Home | MoveToBeginningOfLine | MoveToBeginningOfLineAndModifySelection | MoveToBeginningOfDocument | MoveToBeginningOfDocumentAndModifySelection | | | | |
| End | MoveToEndOfLine | MoveToEndOfLineAndModifySelection | MoveToEndOfDocument | MoveToEndOfDocumentAndModifySelection | | | | |
| Backspace | DeleteBackward | DeleteBackward | DeleteWordBackward | | DeleteWordBackward | | DeleteToBeginningOfLine | |
| Delete | DeleteForward | Cut | DeleteWordForward | | DeleteWordForward | | DeleteToEndOfLine | |
| Insert | | (paste: none, host event) | Copy | | | | | |
| Z | | | Undo | Redo | | | Undo | Redo |
| Y | | | Redo | | | | | |
| C / X / A | | | Copy / Cut / SelectAll | | | | Copy / Cut / SelectAll | |
| B / I / U | | | ToggleBold / ToggleItalic / ToggleUnderline | | | | same | |

All command names exist in EditorCommand.cpp (checked). No `Paste` row anywhere: the host paste
event is the only clipboard source (notes/rendering-input.md § Clipboard). No Tab row:
`InsertTab` is text insertion, and with step 1 `defaultTabEventHandler` moves focus on keydown
first, so Tab only inserts in `designMode` (Chrome behaviour). Keep the "skip text-insertion
commands on RawKeyDown" rule in `handleEditingKeyboardEvent`.

`commandForChar`: `"\r"` → `InsertLineBreak` when Shift is held, else `InsertNewline`
(Shift+Enter in contenteditable inserts `<br>`; in a textarea both insert a newline).

Guest-visible effects worth knowing: PageUp/Down with a textarea focused now move the caret
and do not scroll the page; Cmd+←/→ outside editable content does nothing (Chrome Mac would
go back/forward; not adding engine history keys here).

### 4. Undo/redo client (BibPageClients.h)

```cpp
// Undo manager (WebCore registers steps; we only own the stacks — the shape of
// WebKit's DefaultUndoController plus NSUndoManager's "new edit drops redo").
static constexpr size_t kMaxUndoSteps = 100;
Vector<Ref<WebCore::UndoStep>> m_undoStack, m_redoStack;
bool m_inUndoRedo { false };

static void dropAll(Vector<Ref<WebCore::UndoStep>>& stack)
{
    for (auto& step : std::exchange(stack, { })) step->didRemoveFromUndoManager();
}
void registerUndoStep(WebCore::UndoStep& step) final
{
    if (!m_inUndoRedo) dropAll(m_redoStack);
    if (m_undoStack.size() >= kMaxUndoSteps) m_undoStack.takeFirst()->didRemoveFromUndoManager();
    m_undoStack.append(step);
}
void registerRedoStep(WebCore::UndoStep& step) final { m_redoStack.append(step); }
void clearUndoRedoOperations() final { dropAll(m_undoStack); dropAll(m_redoStack); }
bool canUndo() const final { return !m_undoStack.isEmpty(); }
bool canRedo() const final { return !m_redoStack.isEmpty(); }
void undo() final
{
    if (m_undoStack.isEmpty()) return;
    auto step = m_undoStack.takeLast();
    SetForScope scope(m_inUndoRedo, true);
    step->unapply();   // WebCore → unappliedEditing → registerRedoStep
}
void redo() final { /* mirror: takeLast from redo, reapply → registerUndoStep */ }
```

`m_inUndoRedo` matters only in `redo()`: `reappliedEditing` re-registers the undo step and
must not wipe the remaining redo stack. `unapply` returns early on a cancelled `beforeinput`
(`historyUndo`) or a disconnected editable root — the step is dropped either way, as upstream.
Stacks are per page, which is per engine (one page), matching WebKit2.

`document.execCommand('undo'/'redo')`, `queryCommandEnabled('undo')` and the Ctrl/Cmd+Z rows
in step 3 all route through `Editor::undo()` → this client; nothing else to wire.

### 5. Viewer: Mac Alt+arrows are not host keys (src/ext/keys.mjs, viewer.mjs)

`hostKey(e, mac)` (and `hostPasteKey`/`keyText` unchanged): when `mac`, `Alt+←/→/Home` are
forwarded (Chrome Mac's history keys are Cmd+[ / Cmd+←, not Alt); the F4 case stays. Viewer
computes once `const MAC = navigator.userAgentData?.platform === 'macOS' ||
/^Mac/.test(navigator.platform)` and passes it. Tier-0 `keys.test.mjs`: Alt+ArrowLeft is host on
PC and forwarded on Mac; Cmd+Z / Cmd+Shift+Z / Ctrl+Y / Ctrl+Backspace / Shift+Home are all
"forwarded and prevented" on both.

### 6. Fixtures and tier-2 scenario (`test/tier2/scenarios.test.mjs`)

Add a `<textarea id="ta" rows="3">` to `test/fixtures/pages/input.html` in a free fixed spot
(the input scenario clicks at (100,100), (95,240), (320,350) and wheels at (600,450); `#field`
autofocuses). New scenario 26 "keys", all assertions via `evalProbe` (guest JS), so no new
pixel zones:

- **Scroll** (`scroll.bstest`, click the page first so the canvas has host focus and the
  engine's focus is `body`): run the current engine once to see these fail. ArrowDown →
  `scrollY > 0`; PageDown → larger; End → `scrollY >= scrollHeight - innerHeight - 1`; Home → 0;
  ArrowUp after PageDown → smaller; Space still scrolls (regression guard). Backspace on body
  → `location.href` unchanged. A guest `keydown` listener that `preventDefault()`s ArrowDown
  → `scrollY` unchanged (defaults stay in the engine).
- **Tab** (`input.bstest`): from `#field`, Tab → `document.activeElement` changes; Shift+Tab →
  back to `#field`.
- **Editing chords** (`input.bstest`, `__bs.eval("ta.focus(); ta.value='alpha beta gamma';
  ta.setSelectionRange(16,16)")`): Ctrl+ArrowLeft → `selectionStart === 11`; Shift+Home →
  `[0, 11]`; Ctrl+Backspace at end → value `'alpha beta '`; Ctrl+Home → 0; Shift+End → `[0, n]`.
  Fill `ta` with 40 lines, caret on line 1: PageDown → caret moves and `scrollY` is unchanged.
- **Undo/redo** (same textarea, value `''`): type `ab` → `'ab'`; `queryCommandEnabled('undo')`
  → true; Ctrl+Z twice → `''` (typing coalesces to one step, so the second is a no-op; the
  assertion holds either way); Ctrl+Y twice → `'ab'`; Ctrl+Shift+Z is a no-op with an empty
  redo stack; a new keystroke after an undo → `queryCommandEnabled('redo')` false. Guest-owned
  undo: a keydown listener that prevents Ctrl+Z → value unchanged.

Firefox subset (`test/tier2/firefox.test.mjs`) gets only the scroll block: the routing that
differs per host browser is the viewer's, and that is what the Firefox tier checks.

### 7. Real-site check, notes, cleanup

- Real sites: tumblr (arrows/PageDown/End), a Wikipedia edit box (word ops, undo), Google Docs
  (its own undo still wins — the keydown is forwarded and it prevents it).
- notes/rendering-input.md § Keyboard: replace the "Known gaps" sentence with the routing
  rules above (platform-free table, keyIdentifier, undo client, Mac Alt+arrows), and add
  scenario 26 to the scenario list in notes/testing.md and the header comment of
  scenarios.test.mjs. plans/text-input.md § out-of-scope and plans/overscroll-wheel-scroll.md
  reference this plan; drop those lines when it's done. Delete this plan.

## Out of scope (noted while reading)

- Windows Alt+letter: `keyText` only suppresses Ctrl/Cmd, so Alt+A inserts "a" (Chrome
  Windows inserts nothing). Mac Option+letter must keep inserting (`å`). Needs a platform
  flag in `keyText` — small, but not part of this.
- Mac Ctrl+A/E/K (Emacs bindings), Cmd+↑/↓ scrolling to document ends outside editable
  content, engine history on Cmd+←/→.
- Focus leaving the engine on Tab past the last focusable element (host focus handoff).
