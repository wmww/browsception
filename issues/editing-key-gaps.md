# Editing keys the engine key map doesn't bind

Since the clipboard landed (2026-09-10) the viewer forwards every Ctrl/Cmd combo that isn't a
host key (src/ext/keys.mjs), and `BibPageClients.h` `commandForKeyDown` decides what it means.
It binds only Backspace/Delete, arrows (Shift+←/→ extend), Home/End, and the clipboard verbs
(Ctrl/Cmd+C/X/A, Ctrl+Insert, Shift+Delete). Missing, by what a user notices:

- **Undo/redo** (Ctrl/Cmd+Z, Ctrl+Y, Cmd+Shift+Z): `BibEditorClient::registerUndoStep` is empty
  and `canUndo()` false, so binding the keys alone does nothing — needs an undo stack in the
  client (WebKitLegacy's `WebEditorClient` shape). Guest editors with their own undo (Docs,
  CodeMirror) work already: they see the keydown.
- **Word ops**: Ctrl+←/→ (Alt on Mac) move by character, Ctrl+Backspace/Delete delete one
  character — the modifier is ignored. WebCore has `MoveWordLeft/Right[AndModifySelection]`,
  `DeleteWordBackward/Forward`.
- **Line/document ops**: Shift+Home/End and Shift+↑/↓ don't extend; Ctrl+Home/End,
  Cmd+←/→/↑/↓ (Mac line/document ends) unbound; PageUp/PageDown inside a textarea.

Shape: a table like WebKitLegacy's `keyDownEntries` (platform-flavoured: Cmd vs Ctrl) plus the
undo client. Tier-2 input scenario is the natural place for probes.
