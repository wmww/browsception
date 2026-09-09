// Static dev server with the COOP/COEP headers required for
// crossOriginIsolated wasm hosting. No deps.
//
//   node tools/dev-server.mjs [root-dir] [--mount /prefix=dir]...
//   (default root: web/, port: $PORT or 8080)
//
// --mount maps a URL prefix to a directory OUTSIDE the root, e.g.
//   --mount /engine=build/webcore/bin
// so multi-GB build artifacts are served in place instead of being copied
// into web/. Each mount gets the same realpath+containment guard as the root.
//
// /vendor is mounted automatically at the repo-root node_modules (when it
// exists), so harness pages can import npm dev deps (binaryen) without
// every call site repeating a --mount flag.

import { createServer, request as httpRequest } from "node:http";
import { createReadStream } from "node:fs";
import { stat, realpath } from "node:fs/promises";
import { join, sep, extname, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const positional = [];
const mounts = []; // [{ prefix: "/engine", root: "/abs/dir" }]
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (arg === "--mount") {
    const spec = process.argv[++i] ?? "";
    const eq = spec.indexOf("=");
    if (eq < 1 || !spec.startsWith("/")) {
      console.error(`dev server: bad --mount "${spec}" (want /prefix=dir)`);
      process.exit(1);
    }
    mounts.push({
      prefix: spec.slice(0, eq).replace(/\/+$/, ""),
      root: await realpath(resolve(spec.slice(eq + 1))),
    });
  } else {
    positional.push(arg);
  }
}
// Built-in /vendor => <repo root>/node_modules, so harness pages can import
// npm dev deps. An explicit --mount /vendor=... wins.
if (!mounts.some((m) => m.prefix === "/vendor")) {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  try {
    mounts.push({ prefix: "/vendor", root: await realpath(join(repoRoot, "node_modules")) });
  } catch {
    // no node_modules (deps not installed) — /vendor just 404s.
  }
}
// Longest prefix wins so /engine/sub can coexist with /engine.
mounts.sort((a, b) => b.prefix.length - a.prefix.length);

const ROOT = await realpath(resolve(positional[0] ?? "web"));
const PORT = Number(process.env.PORT ?? 8080);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".map": "application/json",
  ".wasm": "application/wasm",
  ".data": "application/octet-stream",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

const inRoot = (p, root) => p === root || p.startsWith(root + sep);

const server = createServer(async (req, res) => {
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  // no-cache (NOT no-store): the browser may store but must revalidate, so
  // unchanged artifacts answer 304 and the browsers' wasm machine-code
  // caches stay usable. no-store forced a full re-download AND a full
  // recompile of the ~88 MB engine module on EVERY reload — in Firefox
  // that's a multi-GB transient compile spike per reload.
  res.setHeader("Cache-Control", "no-cache");

  try {
    const url = new URL(req.url, "http://localhost");
    const pathname = decodeURIComponent(url.pathname);

    // browsception 1.2b dev-harness bridge transport: server-side fetch so
    // the (unprivileged) harness page can load arbitrary sites through the
    // engine's host-fetch bridge. DEV ONLY — no guard list here (loopback
    // bind, disposable); the real transport is the extension shim.
    // Contract (mirrors the extension bridge):
    //   GET/POST /__bibproxy?url=<target>
    //     x-bib-method: HTTP method; x-bib-headers: base64(JSON [[k,v],...])
    //   -> 200 always; x-bib-meta: base64(JSON {status,statusText,url,headers})
    //      (redirects NOT followed; body streamed, DECODED — content-encoding/
    //       content-length/transfer-encoding stripped per ABI)
    //      errors -> 502 + x-bib-error
    if (pathname === "/__bibproxy") {
      const target = url.searchParams.get("url") ?? "";
      let t;
      try {
        t = new URL(target);
      } catch {
        res.writeHead(400).end("bad url");
        return;
      }
      if (t.protocol !== "http:" && t.protocol !== "https:") {
        res.writeHead(400).end("bad scheme");
        return;
      }
      const method = req.headers["x-bib-method"] ?? "GET";
      const reqHeaders = req.headers["x-bib-headers"]
        ? JSON.parse(Buffer.from(req.headers["x-bib-headers"], "base64").toString("utf8"))
        : [];
      const bodyChunks = [];
      for await (const c of req) bodyChunks.push(c);
      const body = Buffer.concat(bodyChunks);

      // browsception fixtures: node can't resolve *.bstest (that mapping
      // lives in Chromium's --host-resolver-rules), so dispatch those to
      // the local fixture server (test/fixtures/server.mjs, plain-http
      // port) with the Host header preserved — per-host fixture pages and
      // origins keep working. Raw node:http because fetch() silently drops
      // a Host override (forbidden header).
      if (t.hostname.endsWith(".bstest")) {
        const port = Number(process.env.BIB_BSTEST_PORT ?? 8081);
        const up = httpRequest(
          {
            host: "127.0.0.1",
            port,
            method,
            path: t.pathname + t.search,
            headers: { ...Object.fromEntries(reqHeaders), host: t.host },
          },
          (u) => {
            const drop = new Set(["content-encoding", "content-length", "transfer-encoding"]);
            const pairs = [];
            for (let i = 0; i < u.rawHeaders.length; i += 2) {
              const k = u.rawHeaders[i].toLowerCase();
              if (!drop.has(k)) pairs.push([k, u.rawHeaders[i + 1]]);
            }
            const meta = {
              status: u.statusCode,
              statusText: u.statusMessage ?? "",
              url: target, // no redirects followed — matches redirect:"manual"
              headers: pairs,
            };
            res.writeHead(200, {
              "Content-Type": "application/octet-stream",
              "Cache-Control": "no-store",
              "x-bib-meta": Buffer.from(JSON.stringify(meta), "utf8").toString("base64"),
            });
            u.pipe(res);
          },
        );
        up.on("error", (e) => {
          if (!res.headersSent)
            res.writeHead(502, { "x-bib-error": encodeURIComponent(String(e.message ?? e)) });
          res.end();
        });
        if (body.length && method !== "GET" && method !== "HEAD") up.write(body);
        up.end();
        return;
      }

      let upstream;
      try {
        upstream = await fetch(t, {
          method,
          headers: reqHeaders,
          body: body.length && method !== "GET" && method !== "HEAD" ? body : undefined,
          redirect: "manual",
        });
      } catch (e) {
        res.writeHead(502, {
          "x-bib-error": encodeURIComponent(String(e?.cause?.message ?? e?.message ?? e)),
        });
        res.end();
        return;
      }
      const stripped = new Set(["set-cookie", "content-encoding", "content-length", "transfer-encoding"]);
      const pairs = [];
      upstream.headers.forEach((v, k) => {
        if (!stripped.has(k)) pairs.push([k, v]);
      });
      for (const v of upstream.headers.getSetCookie()) pairs.push(["set-cookie", v]);
      const meta = {
        status: upstream.status,
        statusText: upstream.statusText,
        url: upstream.url,
        headers: pairs,
      };
      res.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Cache-Control": "no-store",
        "x-bib-meta": Buffer.from(JSON.stringify(meta), "utf8").toString("base64"),
      });
      if (upstream.body) {
        try {
          for await (const chunk of upstream.body) res.write(chunk);
        } catch {
          // client went away or upstream died mid-stream; just end.
        }
      }
      res.end();
      return;
    }

    // Which checkout's tree is this? Spawners bind a derived per-checkout port
    // (test/harness/ports.mjs) but two checkouts can hash to the same block —
    // the harness compares this against the root it asked for rather than
    // silently driving a neighbouring worktree's engine.
    if (pathname === "/__whoami") {
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" })
        .end(JSON.stringify({ root: ROOT, mounts: mounts.map((m) => [m.prefix, m.root]), pid: process.pid }));
      return;
    }

    // Cookie-on-redirect probe for scripts/smoke-bridge.mjs: leg 1 sets a
    // cookie on a 302, leg 2 echoes what came back. Proves the engine's jar
    // stores a Set-Cookie from a redirect hop and re-attaches it on the next
    // one (the bridge follows redirects engine-side, so both legs are
    // separate bridge fetches).
    if (pathname === "/cookie-test/redirect-set") {
      res.writeHead(302, {
        Location: "/cookie-test/echo",
        "Set-Cookie": "bibredir=9; Path=/",
        "Cache-Control": "no-store",
      }).end();
      return;
    }
    if (pathname === "/cookie-test/echo") {
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      }).end(`<title>cookie echo</title><pre>cookie: ${req.headers.cookie ?? "(none)"}</pre>`);
      return;
    }

    let root = ROOT;
    let rel = pathname;
    const mount = mounts.find(
      (m) => pathname === m.prefix || pathname.startsWith(m.prefix + "/")
    );
    if (mount) {
      root = mount.root;
      rel = pathname.slice(mount.prefix.length) || "/";
    }

    const candidate = resolve(join(root, rel));
    if (!inRoot(candidate, root)) {
      res.writeHead(403).end("403");
      return;
    }

    // realpath resolves symlinks, so a link placed inside the root can't
    // serve files from outside it
    let file = await realpath(candidate);
    let s = await stat(file);
    if (s.isDirectory()) {
      file = await realpath(join(file, "index.html"));
      s = await stat(file);
    }
    if (!inRoot(file, root)) {
      res.writeHead(403).end("403");
      return;
    }

    // Weak validator from size+mtime — enough for local build artifacts.
    const etag = `W/"${s.size}-${Math.floor(s.mtimeMs)}"`;
    if (req.headers["if-none-match"] === etag) {
      res.writeHead(304, { ETag: etag }).end();
      return;
    }

    // stream instead of buffering: .wasm/.data artifacts can be huge
    res.writeHead(200, {
      "Content-Type": MIME[extname(file)] ?? "application/octet-stream",
      "Content-Length": s.size,
      ETag: etag,
    });
    const stream = createReadStream(file);
    stream.on("error", () => res.destroy());
    stream.pipe(res);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" }).end("404");
  }
});

server.on("error", (err) => {
  console.error(
    err.code === "EADDRINUSE"
      ? `dev server: port ${PORT} is already in use`
      : `dev server: ${err.message}`
  );
  process.exit(1);
});

server.listen(PORT, "127.0.0.1", () => {
  const mountDesc = mounts.map((m) => ` ${m.prefix}=>${m.root}`).join("");
  console.log(
    `dev server: http://127.0.0.1:${PORT}  root=${ROOT}${mountDesc}  COOP/COEP=on`
  );
});
