# BrowserInBrowser embedder target (Phase 2 first-paint gate).
#
# Included from Source/WebCore/PlatformEmscripten.cmake via
# cmake_language(DEFER CALL include ...) — i.e. this file executes in
# WebCore's directory scope AFTER the whole WebCore/CMakeLists.txt has been
# processed: the WebCore target exists and the include-dir lists are final.
# Include-dir consumption copies the WebCoreTestSupport pattern (the bottom
# of WebCore/CMakeLists.txt): WebCore's PRIVATE include dirs do not propagate
# through target_link_libraries, so internal-header consumers replicate them.

get_filename_component(BIB_EMBEDDER_DIR "${EMSCRIPTEN_EMBEDDER_CMAKE}" DIRECTORY)

# Two link targets from the SAME object tree (plans → notes/engine.md § build
# shape). The tree compiles -pthread (BIB_PTHREAD, below); a -pthread-compiled
# object links either way, so the link mode is a target property, not a
# recompile:
#   BibEmbedder       (embedder.js/.wasm)        the SHIPPING link: no threads,
#                     no SharedArrayBuffer, -sENVIRONMENT=worker,web,node. The
#                     extension hosts it in a plain dedicated Worker
#                     (src/ext/engine-worker.js); the dev harness and the node
#                     runner host it on their own thread.
#   BibEmbedderProxy  (proxy/embedder.js/.wasm)  the -sPROXY_TO_PTHREAD link,
#                     kept buildable for a Chrome-only real-threads experiment.
#                     EXCLUDE_FROM_ALL: built only by name
#                     (tools/build-engine.sh --proxy), never staged by default.
# BIB_LINK_PROXY (compile definition, embedder TUs only) is how main.cpp
# tells the two apart — __EMSCRIPTEN_PTHREADS__ is set for BOTH since the
# compile flags are shared.
set(BIB_EMBEDDER_SOURCES
    ${BIB_EMBEDDER_DIR}/BibIDBServer.cpp
    ${BIB_EMBEDDER_DIR}/BibMediaPlayer.cpp
    ${BIB_EMBEDDER_DIR}/BibNetBridge.cpp
    ${BIB_EMBEDDER_DIR}/EmbedderStrategies.cpp
    ${BIB_EMBEDDER_DIR}/main.cpp
)

add_executable(BibEmbedder ${BIB_EMBEDDER_SOURCES})
set_target_properties(BibEmbedder PROPERTIES OUTPUT_NAME embedder)
target_compile_definitions(BibEmbedder PRIVATE BIB_LINK_PROXY=0)

# Same file names in bin/proxy/: Emscripten's glue hard-codes the .wasm name
# it fetches, so a snapshot must ship the pair exactly as linked.
add_executable(BibEmbedderProxy EXCLUDE_FROM_ALL ${BIB_EMBEDDER_SOURCES})
set_target_properties(BibEmbedderProxy PROPERTIES OUTPUT_NAME embedder
    RUNTIME_OUTPUT_DIRECTORY "$<TARGET_FILE_DIR:BibEmbedder>/proxy")
target_compile_definitions(BibEmbedderProxy PRIVATE BIB_LINK_PROXY=1)

# The whole tree compiles -pthread (CMAKE_C/CXX_FLAGS at configure; sysroot
# deps were always -pthread). Flipping it is a full recompile (~1.5-2 h) and
# buys nothing: the plain link below runs a -pthread-compiled tree fine
# (atomics are legal on non-shared memory; pthread/proxying calls resolve to
# emscripten's single-thread stubs). Kept as a knob only so the tree's flags
# stay recorded in one place (tools/build-webcore.sh syncs it).
option(BIB_PTHREAD "Compile the tree -pthread (link mode is per target, above)" ON)

foreach (target BibEmbedder BibEmbedderProxy)
    target_include_directories(${target} PRIVATE
        ${WebCore_INCLUDE_DIRECTORIES}
        ${WebCore_PRIVATE_INCLUDE_DIRECTORIES}
    )
    target_include_directories(${target} SYSTEM PRIVATE
        ${WebCore_SYSTEM_INCLUDE_DIRECTORIES}
    )
    # WebCore is static: its PRIVATE link deps (JSC/WTF/PAL/ssl tier/ICU) reach
    # the final link as $<LINK_ONLY:> interface entries. Skia is linked directly
    # for its INTERFACE include dirs (<skia/...> resolves via symlinked headers).
    target_link_libraries(${target} PRIVATE WebCore Skia::Skia)
endforeach ()

# Shipping link: one thread, one non-shared growable memory. CMake puts the
# tree's CMAKE_CXX_FLAGS (-pthread) on the link line too, and emcc decides
# the runtime shape at link — so -no-pthread (later on the line, wins) is
# what makes this the plain link: no SharedArrayBuffer anywhere in the glue
# (tier-0 engine-imports.test.mjs asserts it), no pthread pool, no proxying.
target_link_options(BibEmbedder PRIVATE
    "SHELL:-no-pthread"
    "SHELL:-sENVIRONMENT=worker,web,node"
)

# Proxy link: the engine runs on a dedicated pthread (-sPROXY_TO_PTHREAD
# moves main() off the browser main thread); needs COOP/COEP + SAB.
# POOL_SIZE=4: 1 taken by proxied main + headroom.
# No OffscreenCanvas/GL settings here on purpose: the engine has no GPU path
# (security.md — the module must import no GL entry point), so nothing
# transfers a canvas to the engine thread.
target_link_options(BibEmbedderProxy PRIVATE
    "SHELL:-pthread"
    "SHELL:-sPROXY_TO_PTHREAD"
    "SHELL:-sPTHREAD_POOL_SIZE=4"
)

# Stamp the link mode next to each artifact: tools/stage-engine.mjs refuses a
# proxy artifact for the extension, and the dev harness (web/browser.html)
# reads BIB_PTHREAD_BUILD to decide whether the page or the engine worker
# pumps. Emitted into the bin dir so the dev server's /engine mount serves it.
file(GENERATE
    OUTPUT "$<TARGET_FILE_DIR:BibEmbedder>/bib-build-config.js"
    CONTENT "// Generated by embedder.cmake — do not edit. Stamps the build's link mode.\nglobalThis.BIB_BUILD_CONFIG = { link: \"plain\", pthreadCompile: $<IF:$<BOOL:${BIB_PTHREAD}>,true,false> };\nglobalThis.BIB_PTHREAD_BUILD = false;\n")
file(GENERATE
    OUTPUT "$<TARGET_FILE_DIR:BibEmbedderProxy>/bib-build-config.js"
    CONTENT "// Generated by embedder.cmake — do not edit. Stamps the build's link mode.\nglobalThis.BIB_BUILD_CONFIG = { link: \"proxy\", pthreadCompile: $<IF:$<BOOL:${BIB_PTHREAD}>,true,false> };\nglobalThis.BIB_PTHREAD_BUILD = true;\n")

foreach (target BibEmbedder BibEmbedderProxy)
target_link_options(${target} PRIVATE
    # Worker-scope Module hooks (pump, wasm2js, injection text): in the plain
    # link the host worker's scope IS the engine's scope; in the proxy link the
    # engine pthread's worker Module inherits nothing from the page (W-B0).
    # NOTE: cmake does not track pre-js edits — tools/build-engine.sh stamps
    # its hash and touches main.cpp to force a relink.
    "SHELL:--pre-js ${BIB_EMBEDDER_DIR}/engine-pre.js"
    "SHELL:-sSTACK_SIZE=8MB"
    "SHELL:-sINITIAL_MEMORY=256MB"
    "SHELL:-sALLOW_MEMORY_GROWTH=1"
    "SHELL:-sMAXIMUM_MEMORY=4GB"
    # EXIT_RUNTIME=0 — under PROXY_TO_PTHREAD a keepalive underflow on the
    # proxied-main pthread with EXIT_RUNTIME=1 tears down the WHOLE runtime
    # mid-session (observed: page Module gutted, exports vanish). The
    # interactive engine must be un-teardownable; gate/node mode calls exit()
    # explicitly in main() so Module.onExit still fires there.
    "SHELL:-sEXIT_RUNTIME=0"
    # FS: the node runner (tools/run-embedder.cjs) reads /out.ppm out of
    # MEMFS in Module.onExit, and both hosts pre-create fontconfig's cache
    # dir in preRun. HEAPU8: the hosts read hook payloads (frames, request
    # JSON) out of the heap. ccall: string-arg exports (bib_key, bib_load_url).
    # stringToUTF8/lengthBytesUTF8: main.cpp reads Module.bibHTML/bibSeedState
    # inside EM_ASM. UTF8ToString: bibPersist/bibChrome decode their payloads
    # inside EM_ASM. ENV: lets the host set engine env vars in preRun.
    "SHELL:-sEXPORTED_RUNTIME_METHODS=FS,HEAPU8,ccall,stringToUTF8,lengthBytesUTF8,UTF8ToString,ENV"
    # Surface the COMPLETE undefined-symbol list per link attempt instead of
    # wasm-ld's default 20-error cutoff — each stub iteration costs minutes.
    "SHELL:-Wl,--error-limit=0"
    # Keep the wasm name section: abort/crash stacks in the browser show
    # real function names instead of wasm-function[N]. Costs binary size
    # only (no codegen change) — load-bearing for site-abort diagnosis.
    "SHELL:--profiling-funcs"
)
endforeach ()

# ICU data archive at the same absolute path ICU compiled in as its default
# data dir (jsc-shell trick — works in node and browser with no env setup).
foreach (target BibEmbedder BibEmbedderProxy)
if (JSC_EMBED_ICU_DATA_FILE)
    target_link_options(${target} PRIVATE
        "SHELL:--embed-file ${JSC_EMBED_ICU_DATA_FILE}@${JSC_EMBED_ICU_DATA_FILE}")
endif ()

# Fonts are load-bearing: fontconfig config tree at /etc/fonts (compiled-in
# --sysconfdir) and at least one real TTF at /usr/share/fonts (compiled-in
# --with-default-fonts). Without both, text paints nothing.
if (BIB_FONTCONFIG_ETC_DIR)
    target_link_options(${target} PRIVATE
        "SHELL:--embed-file ${BIB_FONTCONFIG_ETC_DIR}@/etc/fonts")
endif ()
if (BIB_FONTS_DIR)
    target_link_options(${target} PRIVATE
        "SHELL:--embed-file ${BIB_FONTS_DIR}@/usr/share/fonts")
endif ()
endforeach ()
