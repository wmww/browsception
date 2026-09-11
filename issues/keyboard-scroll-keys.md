# Arrow keys, PageUp/Down and Home/End don't scroll

On any page (verified on `scroll.bstest` and tumblr, with `body` focused and keydowns not
prevented), ↑/↓/PageUp/PageDown/Home/End leave `scrollY` unchanged. Space and Shift+Space work.

Two causes, both on our side:

- `bib_key` (main.cpp) builds `PlatformKeyboardEvent` with `keyIdentifier = emptyString()`.
  WebCore's keyboard scroll defaults dispatch on the identifier: `focusDirectionForKey("Down")`,
  `== "PageDown"`, `== "Home"`. Fill it the way other ports do (`"Up"/"Down"/"Left"/"Right"`,
  `"PageUp"`, `"Home"`, `"U+0020"`…); the viewer already sends `key`/`code`.
- `EventHandler::defaultPageUpDownEventHandler` / `defaultHomeEndEventHandler` are
  `#if PLATFORM(GTK) || PLATFORM(WPE) || PLATFORM(WIN)`, and we build `PORT=Emscripten`, so they
  compile to nothing. The patch needs to add `|| PLATFORM(EMSCRIPTEN)` or the port's equivalent.

Also check that the key map (`BibPageClients.h` `commandForKeyDown` → `MoveDown`, etc.) doesn't
consume arrows or Home/End outside editable content. The commands are disabled there, so
`execute` should return false, but verify. PageUp/Down inside a textarea is tracked in
editing-key-gaps.md. Probe: `scroll.bstest`, click, press keys, read `scrollY` via `__bs.eval`.
