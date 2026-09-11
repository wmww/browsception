// Keyboard routing for the canvas (pure; tier-0 keys.test.mjs). The viewer
// never decides what a combo MEANS — the engine's key map does
// (BibPageClients.h commandForKeyDown). It only decides who gets the key:
//
//   hostKey       the host browser owns it: not forwarded, not prevented.
//   hostPasteKey  forwarded, but NOT prevented: a prevented keydown cancels
//                 the host's paste command, and with it the paste event that
//                 is our only permission-free way to read the clipboard
//                 (notes/rendering-input.md § Clipboard).
//   everything else: forwarded and prevented (Ctrl+C must not copy the
//                 viewer page, Ctrl+S must not open a Save dialog).

const accel = (e) => e.ctrlKey || e.metaKey; // Ctrl, or Cmd on a Mac host
const lower = (e) => (e.key.length === 1 ? e.key.toLowerCase() : e.key);

// Ctrl/Cmd+<key> the browser keeps: tabs, windows, location, reload, zoom
// (host zoom changes the dpr, which the engine follows), quit. Shift
// variants included (Ctrl+Shift+T/N/W/R).
const ACCEL_HOST = new Set(['l', 't', 'w', 'n', 'r', 'q', '=', '+', '-', '0', 'Tab', 'PageUp', 'PageDown', 'F4', 'F5']);

/** True if the host browser owns this key (never forwarded, never prevented). */
export function hostKey(e) {
  const k = lower(e);
  if (k === 'F5' || k === 'F6' || k === 'F11' || k === 'F12') return true;
  if (e.altKey && !accel(e) && (k === 'ArrowLeft' || k === 'ArrowRight' || k === 'Home' || k === 'F4')) return true;
  if (!accel(e)) return false;
  if (ACCEL_HOST.has(k) || /^[1-9]$/.test(k)) return true;
  // DevTools: Ctrl+Shift+I/J/C (Cmd+Opt+I/J/C on a Mac).
  if ((e.shiftKey || e.altKey) && (k === 'i' || k === 'j' || k === 'c')) return true;
  // Clear browsing data, bookmarks bar/manager.
  if (e.shiftKey && (k === 'Delete' || k === 'b' || k === 'o')) return true;
  return false;
}

/** Paste keys: Ctrl/Cmd+V (Shift = paste as plain text), Shift+Insert. */
export function hostPasteKey(e) {
  if (accel(e) && !e.altKey && lower(e) === 'v') return true;
  return e.shiftKey && !accel(e) && !e.altKey && e.key === 'Insert';
}

/**
 * The text a keydown inserts (the CHAR event), or '' for none. Ctrl/Cmd
 * combos insert nothing (Ctrl+C is not a "c"), except AltGr, which some
 * layouts report as Ctrl+Alt with the produced character as the key.
 */
export function keyText(e) {
  const altGr = e.getModifierState?.('AltGraph') || (e.ctrlKey && e.altKey && !e.metaKey);
  if (accel(e) && !altGr) return '';
  if (e.key.length === 1) return e.key;
  if (e.key === 'Enter') return '\r';
  if (e.key === 'Tab') return '\t';
  return '';
}
