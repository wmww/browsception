# Wheel can't scroll the page when the root has `overscroll-behavior` ≠ auto

## Symptom (tumblr.com, logged out)

The page is 5953 px tall in an 861 px viewport. Wheeling anywhere leaves `scrollY` at 0, but
wheeling over the overflow-scroll carousel at the top works, and so do `scrollTo()` and Space.
Tumblr sets `overscroll-behavior: contain` on `html` and `body`. Flipping only `html` to `auto`
in the live page makes the wheel scroll, while `body`'s value has no effect. The same happens on
`scroll.bstest` with `html` set to `contain` or `none` (wheel 3×100 → 0 px; with `auto` → 300 px).
This is not tumblr-specific: `html { overscroll-behavior: none|contain }` is a common way to
turn off bounce and pull-to-refresh, so every site doing that can't be wheel-scrolled in our engine.

## Cause

`EventHandler::handleWheelEventInternal` (pinned `webkitglib/2.52`,
`Source/WebCore/page/EventHandler.cpp` ~L3603) runs the frame view's *propagation* filter
**before** the view scrolls itself:

```cpp
filteredDelta = view->deltaForPropagation(filteredDelta);   // zeroes y when root overscroll-y != auto
if (view->shouldBlockScrollPropagation(filteredDelta))       // true when both axes are ≠ auto
    return true;                                             // → the view never scrolls
```

`LocalFrameView::{horizontal,vertical}OverscrollBehavior` read the root element's style, so the
root's `contain`/`none` makes the main frame's own delta zero, or bails out before scrolling.
Overflow scrollers are unaffected: they're scrolled earlier, in the DOM default handler
(`handleWheelEventInAppropriateEnclosingBox`), which scrolls first and then blocks propagation.
That's why the carousel works.

Other ports rarely take this path, because async scrolling handles the main frame in the
scrolling tree, whose logic is correct. Mac only takes it when a page has a non-passive wheel
listener. Our port is always synchronous (`SynchronousScrolling` in `bibApplyWheel`), so we
always take it.

## Fix: backport upstream 314170@main (`25e43d9150`, 2026-05-29)

"passive:false wheel event listener and overscroll-behavior: contain prevent scrolling"
(bugs.webkit.org/show_bug.cgi?id=281300). This is exactly our bug, and the fix is one hunk:
scroll first, then block propagation only for the leftover.

```diff
     auto adjustedWheelEvent = event;
-    auto filteredDelta = adjustedWheelEvent.delta();
-    filteredDelta = view->deltaForPropagation(filteredDelta);
-    if (view->shouldBlockScrollPropagation(filteredDelta))
-        return true;
-
     if (allowScrolling) {
         // FIXME: ...
-        adjustedWheelEvent = adjustedWheelEvent.copyWithDeltaAndVelocity(filteredDelta, adjustedWheelEvent.scrollingVelocity());
         handledEvent = processWheelEventForScrolling(adjustedWheelEvent, scrollableArea, handling);
         processWheelEventForScrollSnap(adjustedWheelEvent, scrollableArea);
     }
 
+    if (!handledEvent) {
+        auto filteredDelta = view->deltaForPropagation(adjustedWheelEvent.delta());
+        if (view->shouldBlockScrollPropagation(filteredDelta))
+            return true;
+    }
+
     return handledEvent;
```

A subframe whose root is `contain` still scrolls, and once pinned it still returns handled, so
the parent frame doesn't chain. The main frame has no parent, so its `true` is harmless:
`bibApplyWheel` ignores `handled`, and `g_wheelConsumed` reads only `DefaultPrevented`.

Steps:
1. `bash scripts/build-engine.sh --sync-webkit` (take the WebKit tree), then apply the hunk in
   the main checkout's `third_party/WebKit`. This is the patch's first `EventHandler.cpp` hunk.
   Mark it in the patch ledger as an upstream backport, to drop on the next WebKit rebase past
   314170@main.
2. `bash scripts/build-engine.sh` → `node scripts/stage-engine.mjs`. It's one WebCore TU plus a
   relink.
3. Fixture: `scroll.html` reads `?ob=<value>` and sets it on
   `document.documentElement.style.overscrollBehavior`. The server ignores the query.
   Optionally `?frame=1`: a 300×300 same-origin iframe with root `contain` and tall content,
   plus a small scroll-offset probe zone.
4. Tier-2 scenario next to "input coalescing": boot `https://scroll.bstest/?ob=contain`, wheel
   3×100, and assert that the `probe(4, 4)` section index advanced (same decoding as the
   coalescing scenario). Repeat with `ob=none`. For the iframe case, wheel past the iframe's end
   and assert that the iframe scrolled and the main frame didn't (upstream's
   `overscroll-behavior-with-wheel-listener-iframe.html`). Run once against the current engine
   first to see it fail.
5. Real-site check: tumblr.com (logged out) scrolls with the wheel. Then add a line to
   rendering-input.md § scrolling (sync-path + overscroll-behavior gotcha) and delete this plan.

## Out of scope, found alongside

Arrow keys, PageUp/Down and Home/End never scroll any page, while Space does. This is
unrelated to overscroll-behavior. See plans/keyboard-keys.md.
