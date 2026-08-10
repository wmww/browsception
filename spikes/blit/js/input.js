// Pointer / wheel / keyboard capture on the canvas, pushed into the SAB ring.
// Coordinates are translated CSS px -> framebuffer px (the engine's device px).

import { RingWriter, EV } from './ring.js';

function mods(e) {
  return (e.shiftKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.altKey ? 4 : 0) | (e.metaKey ? 8 : 0);
}

export function attachInput(canvas, sab, ctrl, getFbSize) {
  const writer = new RingWriter(sab, ctrl);

  function fbCoords(e) {
    const rect = canvas.getBoundingClientRect();
    const { width, height } = getFbSize();
    return [
      (e.clientX - rect.left) * width / rect.width,
      (e.clientY - rect.top) * height / rect.height,
    ];
  }

  function pushPointer(type, e) {
    const [x, y] = fbCoords(e);
    writer.push(type, x, y, e.button, e.buttons, mods(e), performance.now());
  }

  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    canvas.focus();
    pushPointer(EV.POINTER_DOWN, e);
  });
  canvas.addEventListener('pointermove', (e) => pushPointer(EV.POINTER_MOVE, e));
  canvas.addEventListener('pointerup', (e) => pushPointer(EV.POINTER_UP, e));
  canvas.addEventListener('pointercancel', (e) => pushPointer(EV.POINTER_CANCEL, e));
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault(); // host page never scrolls; deltas go to the engine
    const [x, y] = fbCoords(e);
    writer.push(EV.WHEEL, x, y,
                Math.round(e.deltaX * 100), Math.round(e.deltaY * 100),
                mods(e), performance.now());
  }, { passive: false });

  canvas.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey)) e.preventDefault(); // pass browser combos through
    writer.push(EV.KEY_DOWN, 0, 0, e.keyCode, 0, mods(e), performance.now());
  });
  canvas.addEventListener('keyup', (e) => {
    writer.push(EV.KEY_UP, 0, 0, e.keyCode, 0, mods(e), performance.now());
  });

  return writer;
}
