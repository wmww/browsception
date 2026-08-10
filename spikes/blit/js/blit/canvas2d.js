// 2D-canvas fallback blit path: copy SAB rows into an ImageData (SABs can't back
// ImageData, so this copy is always required) and putImageData with a dirty rect.
// The canvas backing store is fixed at framebuffer size; CSS scales it to the
// element box (putImageData cannot scale). copyMs reports the SAB->ImageData copy.

export function createCanvas2DBlitter(canvas, fbWidth, fbHeight) {
  canvas.width = fbWidth;
  canvas.height = fbHeight;
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) throw new Error('2d context unavailable');
  const imageData = new ImageData(fbWidth, fbHeight);
  const dst = imageData.data;

  return {
    name: '2d',
    renderer: 'canvas2d (' + (navigator.userAgent.match(/Chrom\S+/)?.[0] ?? 'unknown') + ')',
    sabDirect: false,

    blit(fb8, dirty) {
      const y0 = dirty ? dirty.y0 : 0;
      const rows = (dirty ? dirty.y1 : fbHeight) - y0;
      const byteOff = y0 * fbWidth * 4;
      const byteLen = rows * fbWidth * 4;
      const t0 = performance.now();
      dst.set(fb8.subarray(byteOff, byteOff + byteLen), byteOff);
      const copyMs = performance.now() - t0;
      ctx.putImageData(imageData, 0, 0, 0, y0, fbWidth, rows);
      return { copyMs };
    },

    resize() {
      // Backing store stays at framebuffer size; CSS handles display scaling.
    },

    dispose() {},
  };
}
