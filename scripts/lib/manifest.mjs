// One source for both browsers' manifests (plans → notes/extension-platform.md
// § Firefox). Everything else in the extension is shared verbatim; this file
// is the whole divergence budget.
//
// Neither manifest names the extension id: the catch-all is a dynamic rule on
// both browsers (dnr-rules.mjs), so nothing has to be pinned at build time and
// a store-assigned id works unchanged.
//
// Chrome: MV3 service worker, manifest COOP/COEP (harmless now that nothing
// needs SharedArrayBuffer; kept so the viewer stays cross-origin isolated).
// Firefox: no extension service workers — an event page (background.page)
// loads the same module; gecko id for storage.sync + a stable identity.
// Chrome-only keys are dropped rather than left to warn.

export const GECKO_ID = 'browsception@phie.me';
export const FIREFOX_MIN_VERSION = '128.0';

// The one version number. Plain integers (v1, v2, …): there is no API to be
// semver about, and manifests accept 1–4 dot-separated integers that only
// have to increase. Bump it, tag the commit `v<N>`, then `npm run release`
// (release.mjs warns when HEAD isn't tagged with this).
export const VERSION = '2';

// Rendered from icon.svg by scripts/gen-icons.mjs (Chrome takes no SVG).
export const ICON_SIZES = [16, 32, 48, 128];
export const iconPath = (size) => `ext/icons/icon-${size}.png`;
const ICONS = Object.fromEntries(ICON_SIZES.map((s) => [s, iconPath(s)]));

const COMMON = {
  manifest_version: 3,
  name: 'browsception',
  version: VERSION,
  description: 'Runs websites inside a nested wasm browser engine.',
  // Exactly this set (tier-0 manifest.test.mjs pins it; justification per
  // entry in notes/extension-platform.md § Permissions). WithHostAccess, not
  // plain declarativeNetRequest: same API under <all_urls>, no "block
  // content" install warning. `tabs` stays: Chrome hides viewer tabs' own
  // chrome-extension:// URLs from the sweep without it.
  permissions: ['declarativeNetRequestWithHostAccess', 'webRequest', 'storage', 'tabs'],
  host_permissions: ['<all_urls>'],
  icons: ICONS,
  action: { default_popup: 'ext/popup.html', default_title: 'browsception', default_icon: ICONS },
  options_ui: { page: 'ext/options.html', open_in_tab: true },
  // DNR redirects can only target listed resources (spike 0.3).
  web_accessible_resources: [{ resources: ['ext/viewer.html'], matches: ['<all_urls>'] }],
  // MV3 default CSP has no wasm; 'wasm-unsafe-eval' is the (only) MV3-legal
  // way to run the engine. No 'unsafe-eval' — JS stays 'self'.
  content_security_policy: {
    extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
  },
};

export function chromeManifest() {
  return {
    ...COMMON,
    minimum_chrome_version: '124',
    background: { service_worker: 'ext/sw.mjs', type: 'module' },
    cross_origin_opener_policy: { value: 'same-origin' },
    cross_origin_embedder_policy: { value: 'require-corp' },
  };
}

export function firefoxManifest() {
  return {
    ...COMMON,
    browser_specific_settings: { gecko: { id: GECKO_ID, strict_min_version: FIREFOX_MIN_VERSION } },
    background: { page: 'ext/background.html' },
  };
}
