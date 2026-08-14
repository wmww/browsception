// Toolbar popup (2.4, notes/ui.md): master switch, current-tab disposition +
// per-site actions, mode switch. This page is real browser chrome — nested
// content can't draw over it or synthesize clicks into it, so trust
// decisions live here.

import { getState } from './state.mjs';
import { primaryActions } from './actions.mjs';
import { normalizeEntry } from './list-match.mjs';
import { tabUrl, viewerTarget } from './dnr-rules.mjs';

const VIEWER = chrome.runtime.getURL('ext/viewer.html');
const $ = (id) => document.getElementById(id);

function inspectTab(tab) {
  const url = tab ? tabUrl(tab) : '';
  const target = viewerTarget(url, VIEWER);
  if (target !== null) {
    try {
      return { disposition: 'sandboxed', host: new URL(target).hostname, url: target };
    } catch {
      return { disposition: 'other', host: null, url: null };
    }
  }
  if (/^https?:/.test(url)) return { disposition: 'native', host: new URL(url).hostname, url };
  return { disposition: 'other', host: null, url: null };
}

async function render() {
  const state = await getState();
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const { disposition, host, url } = inspectTab(tab);

  $('active').checked = state.active;
  $('activelabel').textContent = state.active ? 'active' : 'inactive';
  $('mode').textContent = state.active ? `${state.mode} mode` : 'inactive';
  $('disposition').textContent = state.active ? disposition : '—';
  $('disposition').className = state.active ? disposition : 'other';
  $('host').textContent = host ?? '';
  $('modeswitch').textContent =
    state.mode === 'whitelist' ? 'Switch to blacklist mode…' : 'Switch to whitelist mode';

  const actions = $('actions');
  actions.replaceChildren();
  for (const action of primaryActions(state, disposition, host)) {
    const b = document.createElement('button');
    b.textContent = action.label;
    b.addEventListener('click', async () => {
      if (action.op === 'open-native-once') {
        await chrome.runtime.sendMessage({ type: 'open-natively', url, tabId: tab.id });
        window.close();
        return;
      }
      const lists = { whitelist: [...state.whitelist], blacklist: [...state.blacklist] };
      const key = { trust: 'whitelist', untrust: 'whitelist', sandbox: 'blacklist', unsandbox: 'blacklist' }[action.op];
      const entry = action.entry ?? normalizeEntry(host);
      if (action.op === 'trust' || action.op === 'sandbox') {
        if (!lists[key].includes(entry)) lists[key].push(entry);
      } else {
        lists[key] = lists[key].filter((e) => e !== entry);
      }
      await chrome.storage.sync.set({ [key]: lists[key] });
      await render(); // sweep applies the disposition; reflect it
    });
    actions.append(b);
  }
}

$('active').addEventListener('change', async (e) => {
  await chrome.storage.sync.set({ active: e.target.checked });
  await render();
});

$('modeswitch').addEventListener('click', async () => {
  const state = await getState();
  const next = state.mode === 'whitelist' ? 'blacklist' : 'whitelist';
  // Switching TO blacklist drops sandbox-by-default — confirm (ui.md).
  if (next === 'blacklist' && !confirm('Blacklist mode runs every unlisted site natively. Switch?'))
    return;
  await chrome.storage.sync.set({ mode: next });
  await render();
});

$('options').addEventListener('click', () => chrome.runtime.openOptionsPage());

await render();
