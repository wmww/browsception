// Frame presentation for the viewer (graduated from spike 0.4 — numbers in
// notes/open-questions.md #10): WebGL2 texSubImage2D of the dirty band —
// ~0.7 ms/full 1080p frame even on SwiftShader — with putImageData as the
// compat fallback. The engine worker hands over one transferable buffer per
// frame holding the full-width dirty rows [y0, y0+rows) (contiguous, single
// texSubImage2D; the band upload is the 6-15x win and column cropping isn't
// worth a staging copy). Both paths copy at call time, so the caller may hand
// the buffer straight back to the worker when present() returns.
//
// The engine owns framebuffer geometry (bibFrame carries fbW/fbH): present()
// re-sizes/recreates on change (WebGL2 texStorage2D is immutable).

const VS = `#version 300 es
void main() {
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

class WebGL2Presenter {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = (this.gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: false,
      desynchronized: true,
    }));
    if (!gl) throw new Error('webgl2 unavailable');
    const prog = gl.createProgram();
    for (const [type, src] of [
      [gl.VERTEX_SHADER, VS],
      [gl.FRAGMENT_SHADER, FS],
    ]) {
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
    this.uCanvasSize = gl.getUniformLocation(prog, 'u_canvasSize');
    this.tex = null;
    this.fbW = 0;
    this.fbH = 0;
  }

  #ensureSize(fbW, fbH) {
    const gl = this.gl;
    if (fbW === this.fbW && fbH === this.fbH) return;
    if (this.tex) gl.deleteTexture(this.tex);
    this.tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, fbW, fbH);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    this.fbW = fbW;
    this.fbH = fbH;
    this.canvas.width = fbW;
    this.canvas.height = fbH;
    gl.viewport(0, 0, fbW, fbH);
  }

  /** band: RGBA8 rows [y0, y0+rows) of an fbW-wide frame (stride fbW*4). */
  present(band, fbW, fbH, y0, rows) {
    const gl = this.gl;
    this.#ensureSize(fbW, fbH);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, y0, fbW, rows, gl.RGBA, gl.UNSIGNED_BYTE, band);
    gl.uniform2f(this.uCanvasSize, this.canvas.width, this.canvas.height);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  dispose() {
    this.gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}

class Canvas2DPresenter {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    if (!this.ctx) throw new Error('2d context unavailable');
  }

  present(band, fbW, fbH, y0, rows) {
    if (this.canvas.width !== fbW || this.canvas.height !== fbH) {
      this.canvas.width = fbW;
      this.canvas.height = fbH;
    }
    const pixels = new Uint8ClampedArray(band.buffer, band.byteOffset, rows * fbW * 4);
    this.ctx.putImageData(new ImageData(pixels, fbW, rows), 0, y0);
  }

  dispose() {}
}

/** WebGL2 with 2d fallback. `mode` forces one ('webgl2' | '2d'). */
export function createPresenter(canvas, mode) {
  if (mode !== '2d') {
    try {
      return new WebGL2Presenter(canvas);
    } catch (e) {
      if (mode === 'webgl2') throw e;
      console.warn('viewer: webgl2 presenter failed, using 2d:', e.message);
    }
  }
  return new Canvas2DPresenter(canvas);
}
