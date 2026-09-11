# Touch input is not forwarded — a touch host can tap but not scroll

`viewer.mjs` wires `mousemove/mousedown/mouseup/wheel` only. On a touch host (Firefox Android,
Windows/ChromeOS touch laptops) the browser synthesizes mouse events for a tap after `touchend`,
so clicks work, but a drag is a page scroll gesture — and the viewer page cannot scroll, so the
nested page never moves. Pinch does nothing. Found while planning plans/text-input.md, whose
touch stage (OSK) is useless until a finger can reach a field.

Fix shape (viewer only, no engine touch events needed first): `touch-action: none` on the canvas,
`pointer*` listeners instead of `mouse*` (a tap = down/up with `pointerType: 'touch'`), a drag =
`bib_wheel` deltas from pointer movement with a simple fling (velocity at release, exponential
decay, per rAF — the wheel coalescing already exists), pinch → ctrl+wheel (engine page zoom).
Long-press → right-click. Real `TouchEvent` forwarding to WebCore (`ENABLE(TOUCH_EVENTS)`) only
if a site needs them (maps, canvases) — separate decision. gui-testing has no touch;
`Input.dispatchTouchEvent` via CDP can drive a tier-2 scenario on Chrome.
