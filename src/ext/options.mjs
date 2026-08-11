// Options page (2.4): full list editors + guard override. Textareas double
// as import/export (paste/copy). Entries are normalized on save; invalid
// lines are dropped with a note.

import { getState } from './state.mjs';
import { normalizeEntry } from './list-match.mjs';

const $ = (id) => document.getElementById(id);

const state = await getState();
$('whitelist').value = state.whitelist.join('\n');
$('blacklist').value = state.blacklist.join('\n');
$('allowPrivateNetwork').checked = !!state.allowPrivateNetwork;

function parseList(text) {
  const entries = [];
  let dropped = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const entry = normalizeEntry(line);
    if (entry && !entries.includes(entry)) entries.push(entry);
    else if (!entry) dropped++;
  }
  return { entries, dropped };
}

$('save').addEventListener('click', async () => {
  const wl = parseList($('whitelist').value);
  const bl = parseList($('blacklist').value);
  await chrome.storage.sync.set({
    whitelist: wl.entries,
    blacklist: bl.entries,
    allowPrivateNetwork: $('allowPrivateNetwork').checked,
  });
  $('whitelist').value = wl.entries.join('\n');
  $('blacklist').value = bl.entries.join('\n');
  const dropped = wl.dropped + bl.dropped;
  $('saved').textContent = `saved${dropped ? ` (${dropped} invalid line${dropped > 1 ? 's' : ''} dropped)` : ''}`;
  setTimeout(() => ($('saved').textContent = ''), 3000);
});
