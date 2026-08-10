// WebGL2 blit path: persistent RGBA8 texture + one static shader pair; per frame
// texSubImage2D of the full frame or the dirty rows, then one draw.
//
// Some browsers reject SAB-backed views in texSubImage2D; on first failure we
// fall back to copying rows into a scratch ArrayBuffer and count that copy as
// part of blit cost (result.copyMs). `sabDirect` records which path is in use.

const VS = `#version 300 es
void main() {
  // Fullscreen triangle from gl_VertexID, no buffers.
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const FS = `#version 300 es
precision mediump float;
uniform sampler2D u_tex;
uniform vec2 u_canvasSize;
out vec4 color;
void main() {
  vec2 uv = gl_FragCoord.xy / u_canvasSize;
  color = texture(u_tex, vec2(uv.x, 1.0 - uv.y)); // fb row 0 is top
}`;

export function createWebGL2Blitter(canvas, fbWidth, fbHeight, { sync = false } = {}) {
  const gl = canvas.getContext('webgl2', {
    alpha: false, antialias: false, depth: false, stencil: false,
    preserveDrawingBuffer: false, desynchronized: true,
  });
  if (!gl) throw new Error('webgl2 unavailable');

  const prog = gl.createProgram();
  for (const [type, src] of [[gl.VERTEX_SHADER, VS], [gl.FRAGMENT_SHADER, FS]]) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS))
      throw new Error('shader: ' + gl.getShaderInfoLog(sh));
    gl.attachShader(prog, sh);
  }
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS))
    throw new Error('link: ' + gl.getProgramInfoLog(prog));
  gl.useProgram(prog);
  const uCanvasSize = gl.getUniformLocation(prog, 'u_canvasSize');

  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, fbWidth, fbHeight);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);

  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  const renderer = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)
                       : gl.getParameter(gl.RENDERER);

  let sabDirect = true;
  let scratch = null; // lazily allocated non-shared copy buffer

  function upload(view, y0, rows) {
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, y0, fbWidth, rows,
                     gl.RGBA, gl.UNSIGNED_BYTE, view);
  }

  return {
    name: 'webgl2',
    renderer,
    get sabDirect() { return sabDirect; },

    // fb8: Uint8Array over the SAB framebuffer. dirty: {y0, y1} or null for full.
    // Returns { copyMs } (0 when uploading straight from the SAB).
    blit(fb8, dirty) {
      const y0 = dirty ? dirty.y0 : 0;
      const rows = (dirty ? dirty.y1 : fbHeight) - y0;
      const byteOff = y0 * fbWidth * 4;
      const byteLen = rows * fbWidth * 4;
      let copyMs = 0;
      let view = new Uint8Array(fb8.buffer, fb8.byteOffset + byteOff, byteLen);
      if (sabDirect) {
        try {
          upload(view, y0, rows);
        } catch (e) {
          sabDirect = false; // this browser refuses SAB-backed views; copy from now on
        }
      }
      if (!sabDirect) {
        const t0 = performance.now();
        if (!scratch || scratch.length < byteLen) scratch = new Uint8Array(fbWidth * fbHeight * 4);
        scratch.set(view);
        copyMs = performance.now() - t0;
        upload(scratch.subarray(0, byteLen), y0, rows);
      }
      gl.uniform2f(uCanvasSize, canvas.width, canvas.height);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      if (sync) gl.finish(); // measurement mode: include GPU completion in timing
      return { copyMs };
    },

    resize(pixelW, pixelH) {
      canvas.width = pixelW;
      canvas.height = pixelH;
      gl.viewport(0, 0, pixelW, pixelH);
    },

    dispose() {
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    },
  };
}
