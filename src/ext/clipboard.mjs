// Clipboard data between the host and the engine (pure; tier-0
// clipboard.test.mjs). Design: notes/rendering-input.md § Clipboard.
//
// host → engine: the host's paste event is the only source. Its
//   clipboardData becomes one bib_edit "paste" op: strings inline, files as
//   ranges of one byte payload.
// engine → host: a bibChrome "clipboard" signal becomes the record for one
//   ClipboardItem (navigator.clipboard.write), plus the plain text for the
//   writeText fallback.

// String types a DataTransfer exposes that the engine store understands.
const STRING_TYPES = ['text/plain', 'text/html', 'text/uri-list'];
// What navigator.clipboard.write accepts on both hosts.
const WRITABLE_TYPES = new Set(['text/plain', 'text/html', 'image/png']);

export const PASTE_MAX_BYTES = 32 * 1024 * 1024;

/**
 * Snapshot a paste event's DataTransfer and pack it for bib_edit. The strings
 * and File objects are read synchronously — call it inside the event handler,
 * the DataTransfer goes dead after dispatch — and only the file bytes are
 * awaited. Files that would push the payload past `maxBytes` are dropped
 * (strings count too, so a huge text paste keeps its text over images).
 * @returns {Promise<{items: object[], bytes: Uint8Array|null}>}
 */
export async function packDataTransfer(dt, maxBytes = PASTE_MAX_BYTES) {
  const items = [];
  let used = 0;
  for (const type of STRING_TYPES) {
    if (!dt.types?.includes(type)) continue;
    const text = dt.getData(type);
    if (!text) continue;
    items.push({ type, text });
    used += text.length * 2; // upper bound for its UTF-16 → UTF-8 size
  }
  const files = [];
  for (const f of dt.files ?? []) {
    if (used + f.size > maxBytes) continue;
    used += f.size;
    files.push(f);
  }
  if (!files.length) return { items, bytes: null };
  const parts = await Promise.all(files.map((f) => f.arrayBuffer().then((b) => new Uint8Array(b), () => null)));
  const total = parts.reduce((n, p) => n + (p?.byteLength ?? 0), 0);
  const bytes = new Uint8Array(total);
  let off = 0;
  files.forEach((f, i) => {
    const p = parts[i];
    if (!p) return;
    bytes.set(p, off);
    items.push({ type: f.type || 'application/octet-stream', name: f.name ?? '', off, len: p.byteLength });
    off += p.byteLength;
  });
  return { items, bytes };
}

/**
 * The engine's "clipboard" signal → what the viewer writes: `record` for
 * new ClipboardItem(record) (only types the async API accepts; null when
 * none), `plain` for the writeText fallback.
 * @param {string} json  {"items":[{"type","text"}|{"type","name","off","len"}]}
 * @param {ArrayBuffer} [buf]
 */
export function toClipboardRecord(json, buf) {
  let items = [];
  try {
    items = JSON.parse(json).items ?? [];
  } catch {}
  const record = {};
  let plain = '';
  for (const it of items) {
    if (!WRITABLE_TYPES.has(it.type) || record[it.type]) continue;
    if (typeof it.text === 'string') {
      record[it.type] = new Blob([it.text], { type: it.type });
      if (it.type === 'text/plain') plain = it.text;
    } else if (buf && it.off >= 0 && it.len >= 0 && it.off + it.len <= buf.byteLength) {
      record[it.type] = new Blob([new Uint8Array(buf, it.off, it.len)], { type: it.type });
    }
  }
  return { record: Object.keys(record).length ? record : null, plain };
}
