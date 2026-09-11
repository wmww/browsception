# Privacy policy

Browsception collects no data. It has no servers, no analytics, no accounts, and no telemetry.
Nothing you do in the extension leaves your browser except the web requests the sandboxed page
itself makes, and those go directly to the site you are visiting, exactly as they would in a
normal tab.

What the extension stores, all locally:

- Your settings (on/off, mode, and the site lists) in the browser's extension storage. If you
  have browser sync enabled, your browser may sync these settings to your other devices.
- Cookies and site data belonging to sandboxed pages, kept in the nested engine's own store,
  separate from your browser's cookies.

The `<all_urls>`, `webRequest`, `declarativeNetRequestWithHostAccess` and `tabs` permissions are
used only to route navigations into the sandboxed engine, to pass its requests through, and to
tell which open tabs are sandboxed. No request content or tab URL is logged or sent anywhere
else.

Source: https://github.com/wmww/browsception
