# Verify scheme allowlist on viewer ?url= and the URL bar

Fork-era security sweep found `javascript:`/`file:`/`data:` URLs reached the engine
through both the URL bar and the `?url=` param, and that redirects to `file:`/MEMFS let
a remote page read engine-embedded assets (CA bundle, fonts) as page content.

Our bridge enforces the scheme allowlist (notes/networking.md), but confirm the other
entry points do too: `viewer.html?url=` parsing (raw-parse path in viewer.mjs), the
in-page URL bar, and engine-driven redirects/navigation to non-http(s) schemes. Add a
hostile.bstest case for each once verified.
