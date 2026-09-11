# Plan: touch input — taps, drag-to-scroll and fling on touch hosts

Prerequisite of plans/text-input.md stage C (a phone must be able to scroll to a field before an
on-screen keyboard is worth anything). Viewer-only: no engine change, no ABI change.

## Why

`viewer.mjs` wires `mousemove/mousedown/mouseup/wheel` only. On a touch host (Firefox Android,
Windows/ChromeOS touch laptops) the browser synthesizes mouse events after a tap, so clicks
work, but a one-finger drag is a page-scroll gesture on the *viewer* page — which cannot
scroll — so the nested page never moves. Pinch does nothing. viewer.html also has no viewport
meta, so a phone lays the viewer out at the 980 px desktop width and shrinks it.

## Design

**One pointer path for every pointer type.** Replace the four mouse/wheel listeners' mouse half
with `pointerdown/move/up/cancel` (wheel stays). A mouse or pen pointer forwards exactly as
today (move → coalesced `bib_mouse_move`, down/up → `bib_mouse_button`). A touch pointer goes
through a small gesture recognizer, because a finger means something different from a mouse
button: a **tap** is a click, a **drag** is a scroll, and letting go mid-drag is a **fling**.
Nothing touch-shaped crosses the ABI — the engine receives the same mouse and wheel events a
desktop produces, so every guest page behaves as it does under a mouse. That is what every
touch browser without native touch events does, and it is all the engine needs until a site
demands real `TouchEvent`s (§ Not in v1).

- **CSS** — `#screen { touch-action: none }`: the canvas owns every touch gesture (no host
  pan, pull-to-refresh, double-tap zoom or pinch on the viewer page). Plus the missing
  `<meta name="viewport" content="width=device-width, initial-scale=1">` in viewer.html
  (text-input.md appends `interactive-widget=resizes-content` to it later).
- **Recognizer** (`src/ext/pointer-input.mjs`, pure: takes `{move, button, wheel, now}`
  callbacks, returns `{down, move, up, cancel, tick}`; the viewer feeds it pointer events with
  CSS coordinates already converted to device px and the raw CSS movement for deltas):
  - Only the **primary** pointer is tracked (`isPrimary`); a second finger is ignored, and a
    `pointercancel` ends whatever is in progress without a click or a fling.
  - `down` (touch): remember origin, time, and clear any running fling. Nothing is sent yet —
    the engine must not see a mousedown that turns out to be a scroll.
  - `move` (touch): before the **slop** (10 CSS px) is exceeded, nothing. After it, the gesture
    is a drag: each move becomes `wheel(x, y, -dxCss, -dyCss)` (drag up = scroll down; wheel
    deltas are CSS px unscaled, exactly what the wheel listener sends today, and they coalesce
    through the existing per-rAF `pendingWheel`). Keep the last few moves for velocity.
  - `up` (touch): a tap (never left the slop) sends `move(x,y)` then `button(down)` +
    `button(up)` at the tap point — the same mousemove/mousedown/mouseup a mobile browser
    synthesizes, so `:hover` menus and mousedown-driven widgets see what they expect. A drag
    ends with a fling: velocity from the last ~100 ms of moves (px/ms); if above a floor, the
    fling runs in `tick` — per rAF, `v *= decay^dt` (half-life ~150 ms), emit
    `wheel(lastX, lastY, -vx·dt, -vy·dt)`, stop when below ~0.05 px/ms. Any new `down` stops it.
  - **Click count** is computed here for every pointer type (two downs within 400 ms and 20 px
    → 2, etc.) instead of read from `e.detail`: pointer events carry `detail` 0, and the
    recognizer is the natural owner (GTK's WebKit port counts clicks the same way). This
    gives double-tap → word selection for free.
  - Pointer capture on every down (`setPointerCapture`) so a mouse drag past the canvas edge
    keeps delivering moves — a small fix over today's listeners.
- **Viewer wiring** — `wireInput` builds one recognizer and attaches the four pointer
  listeners; `preventDefault` on `pointerdown` (this also suppresses the compat mouse events a
  tap would otherwise synthesize, so nothing double-clicks); `tickLoop` calls `rec.tick()`
  before flushing the wheel. `hostButton` (mouse back/forward) stays. `canvas.focus()` on
  every down as today.

## Steps

1. `pointer-input.mjs` + tier-0 `pointer-input.test.mjs` with an injected clock: tap → one
   move, down, up with clickCount 1; second tap 200 ms later → clickCount 2; drag → the wheel
   deltas sum to minus the finger movement, nothing before the slop; release at speed → fling
   deltas decay monotonically, total distance ≈ v/λ and bounded; cancel mid-drag → no fling;
   mouse pointer → move/down/up passthrough unchanged; a non-primary pointer → ignored.
2. viewer.mjs + viewer.html changes above; delete the mouse listeners. Existing tier-2 input
   scenarios (9, 14, 19, hidpi) still drive the canvas via Playwright's mouse, which fires
   pointer events — they are the regression net for the mouse path.
3. Tier-2 Chrome scenario **"touch"** (`context.newCDPSession(page)` +
   `Emulation.setTouchEmulationEnabled` then `Input.dispatchTouchEvent`, or a
   `hasTouch: true` context and `page.touchscreen.tap`): on `scroll.bstest`, a 300 px upward
   drag → `__bs.probe(4,4)` decodes ≈ 300 px of scroll; a fast release → offset keeps growing
   for a few frames then stops; a tap on `input.bstest`'s click zone flips it. Firefox: BiDi
   `input.performActions` refuses extension pages (testing.md § Launch recipes); a
   chrome-window synthesis like the harness's `page.press` would be needed for touch —
   otherwise manual.
4. Manual smoke on Firefox Android (`web-ext run -t firefox-android`): Wikipedia — scroll,
   fling, tap a link, tap the URL bar.
5. Notes: rendering-input.md § Pointer/§ Touch rewritten to the recognizer (touch = mouse +
   wheel, not TouchEvents), testing.md line "touch input stays untested" updated,
   roadmap fast-follow 2 sentence. Delete this plan.

## Not in v1

- **Pinch zoom.** The engine has no zoom of any kind today (no `setPageZoomFactor` call; a
  ctrl+wheel just scrolls). When zoom lands — one `bib_zoom(factor)` export over
  `LocalFrame::setPageZoomFactor`, shared by Ctrl/Cmd+±, ctrl+wheel and pinch — the recognizer
  gains a two-pointer distance ratio. Until then `touch-action: none` also means no host pinch
  of the viewer page; a blurry host zoom was judged worse than none.
- **Long-press → context menu**: nothing in the viewer draws one yet; a guest `contextmenu`
  handler is the only consumer. Add with the viewer context menu.
- **Touch text selection / handles** (text-input.md § Not in this plan).
- **Real `TouchEvent`s** (`ENABLE(TOUCH_EVENTS)`, maps, drawing canvases): a separate decision
  with an ABI export; the recognizer would then forward raw touches and let the engine decide
  whether a gesture scrolls — which is the whole touch-action machinery, so only if a site
  that matters needs it.
