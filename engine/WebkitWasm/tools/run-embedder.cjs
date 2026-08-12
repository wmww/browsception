// Browser-free embedder smoke: execute the embedder under node and extract
// /out.ppm from MEMFS to build/ after exit.
//
// Two Emscripten-under-node traps handled here:
// 1. The project package.json is "type":"module" — build/webcore/bin/ gets
//    its own {"type":"commonjs"} package.json (build-webcore.sh) so
//    require() works on embedder.js.
// 2. `global.Module` config is IGNORED: the script's hoisted
//    `var Module = typeof Module != "undefined" ? Module : {}` shadows the
//    global. But it sets `module.exports = Module` and wasm instantiation is
//    async, so config attached synchronously AFTER require() is in place
//    before the runtime starts.
'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const jsPath = path.join(root, 'build/webcore/bin/embedder.js');
const outPath = path.join(root, 'build/out.ppm');

const Module = require(jsPath);

Module.preRun = Module.preRun || [];
Module.preRun.push(() => {
    // fontconfig's compiled-in cache dir; MEMFS starts without /var.
    Module.FS.mkdirTree('/var/cache/fontconfig');
});

Module.onExit = (code) => {
    try {
        const data = Module.FS.readFile('/out.ppm');
        fs.writeFileSync(outPath, Buffer.from(data));
        console.log(`RUNNER: wrote ${outPath} (${data.length} bytes)`);
    } catch (e) {
        console.log(`RUNNER: no /out.ppm (${e.message})`);
    }
    console.log(`RUNNER: exit code ${code}`);
};
