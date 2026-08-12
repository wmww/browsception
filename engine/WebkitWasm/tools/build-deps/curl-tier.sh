#!/usr/bin/env bash
# Build the curl tier for wasm32-emscripten into wasm-sysroot (decision-003):
# OpenSSL -> nghttp2 -> brotli -> libpsl -> curl -> fontconfig.
# Static libs, -O2 -pthread everywhere (pthread ABI must match the engine).
# Idempotent per-dep: skips anything already installed in the sysroot.
# Run AFTER webcore-deps.sh (needs zlib/libxml2/freetype/icu in the sysroot).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TP="$ROOT/third_party"
SYSROOT="$TP/wasm-sysroot"
DEPS="$TP/build-deps"
JOBS="${JOBS:-$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 4)}"

source "$TP/emsdk/emsdk_env.sh" > /dev/null 2>&1
export CFLAGS="-O2 -pthread" CXXFLAGS="-O2 -pthread"
# Cross pkg-config: resolve ONLY against the wasm sysroot, never the host.
export PKG_CONFIG_LIBDIR="$SYSROOT/lib/pkgconfig"
export PKG_CONFIG_PATH=""
mkdir -p "$DEPS" "$SYSROOT"
cd "$DEPS"

fetch() { # fetch <url> <tarball-name>
  [ -f "$2" ] || curl -fL --retry 3 -o "$2" "$1"
}

unpack() { # unpack <tarball> <dir>
  if [ ! -d "$2" ]; then mkdir "$2" && tar xf "$1" -C "$2" --strip-components=1; fi
}

cmake_build() { # cmake_build <srcdir> <builddir> [extra cmake args...]
  local src="$1" bld="$2"; shift 2
  emcmake cmake -S "$src" -B "$bld" -GNinja \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_INSTALL_PREFIX="$SYSROOT" \
    -DCMAKE_FIND_ROOT_PATH="$SYSROOT" \
    -DBUILD_SHARED_LIBS=OFF \
    "$@" > "$bld-configure.log" 2>&1
  ninja -C "$bld" install > "$bld-build.log" 2>&1
}

echo "=== OpenSSL ==="
if [ ! -f "$SYSROOT/lib/libssl.a" ]; then
  fetch https://github.com/openssl/openssl/releases/download/openssl-3.5.0/openssl-3.5.0.tar.gz openssl.tar.gz
  unpack openssl.tar.gz openssl
  (cd openssl && \
   emconfigure ./Configure linux-generic32 \
     no-asm no-engine no-afalgeng no-hw no-dso no-shared no-async \
     no-tests no-apps no-docs threads \
     --prefix="$SYSROOT" --libdir=lib --openssldir=/etc/ssl \
     -O2 -pthread > ../openssl-configure.log 2>&1 && \
   sed -i 's|^CROSS_COMPILE=.*$|CROSS_COMPILE=|' Makefile && \
   emmake make -j"$JOBS" build_libs > ../openssl-build.log 2>&1 && \
   emmake make install_dev >> ../openssl-build.log 2>&1)
fi

echo "=== nghttp2 ==="
if [ ! -f "$SYSROOT/lib/libnghttp2.a" ]; then
  fetch https://github.com/nghttp2/nghttp2/releases/download/v1.64.0/nghttp2-1.64.0.tar.xz nghttp2.tar.xz
  unpack nghttp2.tar.xz nghttp2
  cmake_build nghttp2 nghttp2-build \
    -DENABLE_LIB_ONLY=ON -DBUILD_STATIC_LIBS=ON -DENABLE_DOC=OFF
fi

echo "=== brotli ==="
if [ ! -f "$SYSROOT/lib/libbrotlidec.a" ]; then
  fetch https://github.com/google/brotli/archive/refs/tags/v1.1.0.tar.gz brotli.tar.gz
  unpack brotli.tar.gz brotli
  cmake_build brotli brotli-build -DBROTLI_DISABLE_TESTS=ON
fi

echo "=== libpsl ==="
if [ ! -f "$SYSROOT/lib/libpsl.a" ]; then
  fetch https://github.com/rockdaboot/libpsl/releases/download/0.21.5/libpsl-0.21.5.tar.gz libpsl.tar.gz
  unpack libpsl.tar.gz libpsl
  (cd libpsl && \
   emconfigure ./configure --host=wasm32-unknown-emscripten --prefix="$SYSROOT" \
     --disable-shared --enable-static \
     --enable-runtime=libicu --enable-builtin \
     PKG_CONFIG_LIBDIR="$SYSROOT/lib/pkgconfig" \
     > ../libpsl-configure.log 2>&1 && \
   emmake make -j"$JOBS" install > ../libpsl-build.log 2>&1)
  # Static libpsl built with --enable-runtime=libicu carries unresolved ICU
  # symbols, but its .pc advertises only -lpsl — record the private dep so
  # pkg-config consumers link statically without symbol errors (Codex review).
  if ! rg -q "^Requires.private:.*icu-uc" "$SYSROOT/lib/pkgconfig/libpsl.pc"; then
    printf 'Requires.private: icu-uc\n' >> "$SYSROOT/lib/pkgconfig/libpsl.pc"
  fi
fi

echo "=== curl ==="
if [ ! -f "$SYSROOT/lib/libcurl.a" ]; then
  fetch https://curl.se/download/curl-8.17.0.tar.xz curl.tar.xz
  unpack curl.tar.xz curl
  (cd curl && \
   emconfigure ./configure --host=wasm32-unknown-emscripten --prefix="$SYSROOT" \
     --disable-shared --enable-static \
     --with-openssl="$SYSROOT" --with-zlib="$SYSROOT" --with-brotli="$SYSROOT" \
     --with-nghttp2="$SYSROOT" --with-libpsl \
     --with-ca-bundle=/etc/ssl/ca-bundle.crt \
     --enable-http --enable-file --enable-websockets \
     --disable-ftp --disable-ldap --disable-ldaps --disable-rtsp \
     --disable-dict --disable-telnet --disable-tftp --disable-pop3 \
     --disable-imap --disable-smtp --disable-gopher --disable-mqtt \
     --disable-smb --disable-manual --disable-ipv6 \
     --disable-threaded-resolver --disable-unix-sockets --disable-ntlm \
     --without-libidn2 --without-zstd --without-librtmp \
     PKG_CONFIG_LIBDIR="$SYSROOT/lib/pkgconfig" \
     > ../curl-configure.log 2>&1 && \
   emmake make -j"$JOBS" install > ../curl-build.log 2>&1)
fi

echo "=== zlib.pc shim ==="
# zlib was built with CMake (no .pc installed) but freetype2.pc Requires it;
# any pkg-config consumer of freetype (fontconfig here) fails without this.
if [ ! -f "$SYSROOT/lib/pkgconfig/zlib.pc" ]; then
  cat > "$SYSROOT/lib/pkgconfig/zlib.pc" <<EOF
prefix=$SYSROOT
exec_prefix=\${prefix}
libdir=\${prefix}/lib
includedir=\${prefix}/include

Name: zlib
Description: zlib compression library (wasm sysroot)
Version: 1.3.1
Libs: -L\${libdir} -lz
Cflags: -I\${includedir}
EOF
fi

echo "=== fontconfig ==="
# Marker is the .pc (installed near the end), not the .a (installed early) —
# a partial install must not satisfy the guard. Also require etc/fonts: the
# runtime config is copied AFTER the .pc, so check both (Codex review).
if [ ! -f "$SYSROOT/lib/pkgconfig/fontconfig.pc" ] || [ ! -f "$SYSROOT/etc/fonts/fonts.conf" ]; then
  fetch https://www.freedesktop.org/software/fontconfig/release/fontconfig-2.15.0.tar.xz fontconfig.tar.xz
  unpack fontconfig.tar.xz fontconfig
  # fontconfig 2.15 ships a config.sub too old to know 'emscripten';
  # libpsl (2024) carries a current one.
  cp -f libpsl/build-aux/config.sub libpsl/build-aux/config.guess fontconfig/ 2>/dev/null || true
  (cd fontconfig && \
   emconfigure ./configure --host=wasm32-unknown-emscripten --prefix="$SYSROOT" \
     --disable-shared --enable-static --disable-docs \
     --enable-libxml2 --sysconfdir=/etc \
     --with-default-fonts=/usr/share/fonts \
     --with-cache-dir=/var/cache/fontconfig \
     LIBXML2_CFLAGS="-I$SYSROOT/include/libxml2" \
     LIBXML2_LIBS="-L$SYSROOT/lib -lxml2 -licuuc -licudata -lz" \
     PKG_CONFIG_LIBDIR="$SYSROOT/lib/pkgconfig" \
     > ../fontconfig-configure.log 2>&1 && \
   emmake make -j"$JOBS" > ../fontconfig-build.log 2>&1 && \
   rm -rf "$DEPS/fontconfig-dest" && \
   emmake make install DESTDIR="$DEPS/fontconfig-dest" >> ../fontconfig-build.log 2>&1)
  # DESTDIR staging: --sysconfdir=/etc is the path fontconfig must see at
  # RUNTIME inside the wasm FS — a direct `make install` would write to the
  # HOST /etc. Merge the prefix part into the sysroot and keep etc/ alongside
  # it for Phase 2 runtime packaging.
  cp -a "$DEPS/fontconfig-dest$SYSROOT/." "$SYSROOT/"
  mkdir -p "$SYSROOT/etc"
  cp -a "$DEPS/fontconfig-dest/etc/." "$SYSROOT/etc/"
fi

echo "=== DONE — sysroot contents ==="
ls "$SYSROOT/lib/" | sort
