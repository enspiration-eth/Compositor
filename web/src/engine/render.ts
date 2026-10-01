// WebGL2 compositor: the browser's stand-in for the Mac app's Metal/Core Image canvas (Rendering/GPUCanvas.swift,
// TiledLayerRenderer.swift, SeparableBlend.swift). Layers are drawn through their transforms, masked, clipped and
// blended one at a time into a document-size framebuffer with all 24 of Compositor's blend modes, computed in sRGB
// as Photoshop does. Adjustment layers read back what is below them and run the original C kernels over it.
import { type Doc, type Layer, type Mat, ancestors, apply, getLayer, invert, isEffectivelyVisible, layerMatrix, mul, renderEffects, effectsMargin, BLEND_MODES, maskInLayerGrid, maskPlacementOf } from './document';
import { adjustmentAsFilter, applyFilter } from './adjustments';
import { unpremultiplyFrom } from './kernels';

const VS = `#version 300 es
in vec2 a_unit;
uniform mat3 u_toDoc;      // unit quad -> document pixels
uniform vec2 u_docSize;
out vec2 v_uv;
out vec2 v_doc;
void main() {
  vec3 d = u_toDoc * vec3(a_unit, 1.0);
  v_uv = a_unit; v_doc = d.xy;
  gl_Position = vec4(d.x / u_docSize.x * 2.0 - 1.0, d.y / u_docSize.y * 2.0 - 1.0, 0.0, 1.0);
}`;
const FS_LAYER = `#version 300 es
precision highp float;
in vec2 v_uv; out vec4 o;
uniform sampler2D u_tex;
void main() { o = texture(u_tex, v_uv); }`;
// Multiplies what is already there by a mask's gray (red channel), via blendFunc(ZERO, SRC_ALPHA).
const FS_MASK = `#version 300 es
precision highp float;
in vec2 v_uv; out vec4 o;
uniform sampler2D u_tex; uniform int u_useAlpha;
void main() { vec4 t = texture(u_tex, v_uv); o = vec4(0.0, 0.0, 0.0, u_useAlpha == 1 ? t.a : t.r); }`;
const FS_BLEND = `#version 300 es
precision highp float;
in vec2 v_uv; out vec4 o;
uniform sampler2D u_backdrop; uniform sampler2D u_src; uniform float u_opacity; uniform int u_mode;
float lum(vec3 c) { return dot(c, vec3(0.3, 0.59, 0.11)); }
vec3 clipColor(vec3 c) { float l = lum(c), n = min(min(c.r, c.g), c.b), x = max(max(c.r, c.g), c.b);
  if (n < 0.0) c = l + (c - l) * l / (l - n); if (x > 1.0) c = l + (c - l) * (1.0 - l) / (x - l); return c; }
vec3 setLum(vec3 c, float l) { return clipColor(c + (l - lum(c))); }
float sat(vec3 c) { return max(max(c.r, c.g), c.b) - min(min(c.r, c.g), c.b); }
vec3 setSat(vec3 c, float s) {
  float mx = max(max(c.r, c.g), c.b), mn = min(min(c.r, c.g), c.b);
  if (mx <= mn) return vec3(0.0);
  return (c - mn) * s / (mx - mn);
}
float burn(float b, float s) { if (b >= 1.0) return 1.0; if (s <= 0.0) return 0.0; return 1.0 - min(1.0, (1.0 - b) / s); }
float dodge(float b, float s) { if (b <= 0.0) return 0.0; if (s >= 1.0) return 1.0; return min(1.0, b / (1.0 - s)); }
float softLight(float b, float s) {
  if (s <= 0.5) return b - (1.0 - 2.0 * s) * b * (1.0 - b);
  float d = b <= 0.25 ? ((16.0 * b - 12.0) * b + 4.0) * b : sqrt(b);
  return b + (2.0 * s - 1.0) * (d - b);
}
float hardLight(float b, float s) { return s <= 0.5 ? b * 2.0 * s : 1.0 - (1.0 - b) * (1.0 - (2.0 * s - 1.0)); }
float sep(int m, float b, float s) {
  if (m == 1) return min(b, s);
  if (m == 2) return b * s;
  if (m == 3) return burn(b, s);
  if (m == 4) return max(0.0, b + s - 1.0);
  if (m == 5) return max(b, s);
  if (m == 6) return b + s - b * s;
  if (m == 7) return dodge(b, s);
  if (m == 8) return min(1.0, b + s);
  if (m == 9) return hardLight(s, b);
  if (m == 10) return softLight(b, s);
  if (m == 11) return hardLight(b, s);
  if (m == 12) return s <= 0.5 ? burn(b, 2.0 * s) : dodge(b, 2.0 * s - 1.0);
  if (m == 13) return clamp(b + 2.0 * s - 1.0, 0.0, 1.0);
  if (m == 14) return s <= 0.5 ? min(b, 2.0 * s) : max(b, 2.0 * s - 1.0);
  if (m == 15) return b + s >= 1.0 ? 1.0 : 0.0;
  if (m == 16) return abs(b - s);
  if (m == 17) return b + s - 2.0 * b * s;
  if (m == 18) return max(0.0, b - s);
  if (m == 19) return s <= 0.0 ? (b > 0.0 ? 1.0 : 0.0) : min(1.0, b / s);
  return s;
}
void main() {
  vec4 B = texture(u_backdrop, v_uv), S = texture(u_src, v_uv);
  float as = S.a * u_opacity, ab = B.a;
  vec3 cs = S.a > 0.0 ? S.rgb / S.a : vec3(0.0), cb = ab > 0.0 ? B.rgb / ab : vec3(0.0);
  vec3 mixed;
  if (u_mode == 0) mixed = cs;
  else if (u_mode == 20) mixed = setLum(setSat(cs, sat(cb)), lum(cb));
  else if (u_mode == 21) mixed = setLum(setSat(cb, sat(cs)), lum(cb));
  else if (u_mode == 22) mixed = setLum(cs, lum(cb));
  else if (u_mode == 23) mixed = setLum(cb, lum(cs));
  else mixed = vec3(sep(u_mode, cb.r, cs.r), sep(u_mode, cb.g, cs.g), sep(u_mode, cb.b, cs.b));
  vec3 csp = (1.0 - ab) * cs + ab * clamp(mixed, 0.0, 1.0);
  float ao = as + ab * (1.0 - as);
  o = vec4(as * csp + (1.0 - as) * B.rgb, ao);
}`;
const VS_SCREEN = `#version 300 es
in vec2 a_unit; out vec2 v_unit;
void main() { v_unit = a_unit; gl_Position = vec4(a_unit * 2.0 - 1.0, 0.0, 1.0); }`;
const FS_SCREEN = `#version 300 es
precision highp float;
in vec2 v_unit; out vec4 o;
uniform sampler2D u_tex; uniform vec2 u_screen; uniform vec2 u_offset; uniform float u_scale; uniform vec2 u_docSize; uniform float u_dpr;
uniform int u_pixelGrid;
void main() {
  vec2 frag = vec2(gl_FragCoord.x, u_screen.y - gl_FragCoord.y);
  vec2 doc = (frag - u_offset) / u_scale;
  vec3 bg = vec3(0.118);
  if (doc.x < 0.0 || doc.y < 0.0 || doc.x >= u_docSize.x || doc.y >= u_docSize.y) { o = vec4(bg, 1.0); return; }
  vec2 cell = floor(frag / (8.0 * u_dpr));
  float check = mod(cell.x + cell.y, 2.0) < 1.0 ? 1.0 : 0.82;
  vec4 c = texture(u_tex, doc / u_docSize);
  vec3 col = c.rgb + vec3(check) * (1.0 - c.a);
  if (u_pixelGrid == 1) { vec2 f = fract(doc); vec2 w = vec2(1.0 / u_scale); if (f.x < w.x || f.y < w.y) col = mix(col, vec3(0.5), 0.25); }
  o = vec4(col, 1.0);
}`;

interface Target { fbo: WebGLFramebuffer; tex: WebGLTexture; w: number; h: number }
interface CachedTex { tex: WebGLTexture; key: string; w: number; h: number }

export class Renderer {
  gl: WebGL2RenderingContext;
  private layerProg: WebGLProgram; private maskProg: WebGLProgram; private blendProg: WebGLProgram; private screenProg: WebGLProgram;
  private quad: WebGLVertexArrayObject;
  private targets: Target[] = [];
  private texCache = new Map<string, CachedTex>();
  private effectCache = new Map<string, { key: string; canvas: HTMLCanvasElement; margin: number }>();
  private adjCache = new Map<string, { key: string; tex: WebGLTexture }>();
  composite: Target | null = null;
  private compositeKey = '';
  frameKey = 0;

  constructor(public canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', { premultipliedAlpha: false, alpha: false, antialias: false, preserveDrawingBuffer: true });
    if (!gl) throw new Error('WebGL2 is required');
    this.gl = gl;
    this.layerProg = this.program(VS, FS_LAYER); this.maskProg = this.program(VS, FS_MASK);
    this.blendProg = this.program(VS, FS_BLEND); this.screenProg = this.program(VS_SCREEN, FS_SCREEN);
    this.quad = gl.createVertexArray()!;
    gl.bindVertexArray(this.quad);
    const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    for (const p of [this.layerProg, this.maskProg, this.blendProg, this.screenProg]) {
      const loc = gl.getAttribLocation(p, 'a_unit');
      if (loc >= 0) { gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0); }
    }
  }
  private program(vs: string, fs: string) {
    const gl = this.gl;
    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)!; gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader');
      return s;
    };
    const p = gl.createProgram()!;
    gl.attachShader(p, sh(gl.VERTEX_SHADER, vs)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs));
    gl.bindAttribLocation(p, 0, 'a_unit');
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? 'link');
    return p;
  }
  private target(w: number, h: number): Target {
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    return { fbo, tex, w, h };
  }
  private ensureTargets(w: number, h: number) {
    if (this.targets.length && this.targets[0].w === w && this.targets[0].h === h) return;
    for (const t of this.targets) { this.gl.deleteTexture(t.tex); this.gl.deleteFramebuffer(t.fbo); }
    this.targets = [0, 1, 2, 3, 4].map(() => this.target(w, h));
    this.compositeKey = '';
    for (const a of this.adjCache.values()) this.gl.deleteTexture(a.tex);
    this.adjCache.clear();
  }
  private uploadTex(key: string, versionKey: string, src: TexImageSource, w: number, h: number, nearest = false, premultiply = true): WebGLTexture {
    const gl = this.gl;
    let c = this.texCache.get(key);
    if (c && c.key === versionKey) return c.tex;
    if (!c) { c = { tex: gl.createTexture()!, key: '', w, h }; this.texCache.set(key, c); }
    gl.bindTexture(gl.TEXTURE_2D, c.tex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, premultiply);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, src);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, nearest ? gl.NEAREST : gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, nearest ? gl.NEAREST : gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    c.key = versionKey; c.w = w; c.h = h;
    return c.tex;
  }
  private mat3(m: Mat) { return new Float32Array([m[0], m[1], 0, m[2], m[3], 0, m[4], m[5], 1]); }
  private drawQuad(prog: WebGLProgram, toDoc: Mat, docW: number, docH: number, tex: WebGLTexture, extra?: (p: WebGLProgram) => void) {
    const gl = this.gl;
    gl.useProgram(prog);
    gl.uniformMatrix3fv(gl.getUniformLocation(prog, 'u_toDoc'), false, this.mat3(toDoc));
    gl.uniform2f(gl.getUniformLocation(prog, 'u_docSize'), docW, docH);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(gl.getUniformLocation(prog, 'u_tex'), 0);
    extra?.(prog);
    gl.bindVertexArray(this.quad);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
  private layerSource(l: Layer): { canvas: HTMLCanvasElement; margin: number } {
    const c = l.canvas!;
    if (!l.effects || effectsMargin(l.effects) === 0 && !l.effects.colorOverlay && !l.effects.innerGlow && !l.effects.innerShadow && !l.effects.stroke) return { canvas: c, margin: 0 };
    const scale = l.transform.w / c.width || 1;
    const key = `${l.rev}|${JSON.stringify(l.effects)}|${scale.toFixed(4)}`;
    const cached = this.effectCache.get(l.id);
    if (cached && cached.key === key) return cached;
    const r = renderEffects(c, l.effects, scale);
    this.effectCache.set(l.id, { key, ...r });
    return r;
  }

  /** Composites the document; returns true when the result changed. */
  render(doc: Doc, overlayKey = ''): boolean {
    const gl = this.gl, W = doc.width, H = doc.height;
    this.ensureTargets(W, H);
    const sigParts: string[] = [`${W}x${H}`];
    const leaves = doc.layers.filter(l => !l.isGroup && isEffectivelyVisible(doc, l));
    for (const l of leaves) sigParts.push(this.layerSig(doc, l));
    const key = sigParts.join(';') + overlayKey;
    if (key === this.compositeKey && this.composite) return false;
    this.compositeKey = key;
    const [A, B, L, C, T] = this.targets;
    let accum = A, other = B;
    gl.viewport(0, 0, W, H);
    gl.disable(gl.BLEND);
    for (const t of [A, L, C]) { gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT); }
    const clipBases = new Set(doc.layers.map(l => l.clipTo).filter(Boolean) as string[]);
    const unitDoc: Mat = [W, 0, 0, H, 0, 0];
    let belowSig = '';
    for (const l of leaves) {
      const sig = this.layerSig(doc, l);
      // 1. Layer pass: this layer's pixels, placed, into L.
      gl.bindFramebuffer(gl.FRAMEBUFFER, L.fbo); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
      gl.disable(gl.BLEND);
      if (l.adjustment) {
        const tex = this.adjustedBackdrop(l, accum, W, H, belowSig + '|' + JSON.stringify(l.adjustment));
        // adjustedBackdrop reads back the accumulation: draw into L again.
        gl.bindFramebuffer(gl.FRAMEBUFFER, L.fbo); gl.viewport(0, 0, W, H);
        this.drawQuad(this.layerProg, unitDoc, W, H, tex);
      } else if (l.canvas) {
        const src = this.layerSource(l);
        const m = layerMatrix(l);
        const nearest = l.transform.sampling === 'Nearest';
        const tex = this.uploadTex('L' + l.id, `${l.rev}|${src.canvas.width}x${src.canvas.height}|${src === (l as unknown) ? 0 : src.margin}|${l.effects ? JSON.stringify(l.effects) : ''}`, src.canvas, src.canvas.width, src.canvas.height, nearest);
        const toDoc = mul(m, [src.canvas.width, 0, 0, src.canvas.height, -src.margin, -src.margin]);
        this.drawQuad(this.layerProg, toDoc, W, H, tex);
      }
      // 2. Masks: the layer's own, then every enclosing folder's.
      gl.enable(gl.BLEND); gl.blendFunc(gl.ZERO, gl.SRC_ALPHA);
      const masked = [l, ...ancestors(doc, l)].filter(x => x.mask && x.maskEnabled);
      for (const x of masked) {
        const mk = maskInLayerGrid(x)!;
        const mt = this.uploadTex('M' + x.id, `${x.rev}|${mk.width}|${mk === x.mask ? '' : JSON.stringify(maskPlacementOf(x)) + JSON.stringify(x.transform)}`, mk, mk.width, mk.height, false, false);
        const pw = x.canvas ? x.canvas.width : mk.width, ph = x.canvas ? x.canvas.height : mk.height;
        const toDoc = mul(layerMatrix(x), [pw, 0, 0, ph, 0, 0]);
        this.drawQuad(this.maskProg, toDoc, W, H, mt, p => gl.uniform1i(gl.getUniformLocation(p, 'u_useAlpha'), 0));
      }
      // 3. Clipping: only where the base layer has pixels.
      if (l.clipTo && getLayer(doc, l.clipTo)) this.drawQuad(this.maskProg, unitDoc, W, H, C.tex, p => gl.uniform1i(gl.getUniformLocation(p, 'u_useAlpha'), 1));
      gl.disable(gl.BLEND);
      if (clipBases.has(l.id)) {
        // Keep this layer's coverage for the layers clipped to it (copy L into C).
        gl.bindFramebuffer(gl.FRAMEBUFFER, C.fbo); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
        this.drawQuad(this.layerProg, unitDoc, W, H, L.tex);
      }
      // 4. Blend L over the accumulation, with the layer's mode and its opacity times its folders'.
      const opacity = [l, ...ancestors(doc, l)].reduce((a, x) => a * x.opacity, 1);
      gl.bindFramebuffer(gl.FRAMEBUFFER, other.fbo);
      gl.useProgram(this.blendProg);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, accum.tex);
      gl.uniform1i(gl.getUniformLocation(this.blendProg, 'u_backdrop'), 1);
      gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, L.tex);
      gl.uniform1i(gl.getUniformLocation(this.blendProg, 'u_src'), 2);
      gl.uniform1f(gl.getUniformLocation(this.blendProg, 'u_opacity'), opacity);
      gl.uniform1i(gl.getUniformLocation(this.blendProg, 'u_mode'), Math.max(0, BLEND_MODES.indexOf(l.blend)));
      gl.uniformMatrix3fv(gl.getUniformLocation(this.blendProg, 'u_toDoc'), false, this.mat3(unitDoc));
      gl.uniform2f(gl.getUniformLocation(this.blendProg, 'u_docSize'), W, H);
      gl.bindVertexArray(this.quad); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      [accum, other] = [other, accum];
      belowSig += sig + ';';
    }
    void T;
    // Mipmapped copy for zoomed-out display (Compositor's "sharp high-quality downsampling").
    if (!this.composite || this.composite.w !== W || this.composite.h !== H) {
      if (this.composite) { gl.deleteTexture(this.composite.tex); gl.deleteFramebuffer(this.composite.fbo); }
      this.composite = this.target(W, H);
    }
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, accum.fbo); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.composite.fbo);
    gl.blitFramebuffer(0, 0, W, H, 0, 0, W, H, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, this.composite.tex);
    gl.generateMipmap(gl.TEXTURE_2D);
    this.frameKey++;
    return true;
  }
  private layerSig(doc: Doc, l: Layer) {
    const anc = ancestors(doc, l).map(a => `${a.id}:${a.opacity}:${a.rev}:${a.maskEnabled}:${JSON.stringify(a.maskPlacement)}:${JSON.stringify(a.transform)}`).join(',');
    return `${l.id}:${l.rev}:${l.opacity}:${l.blend}:${l.maskEnabled}:${l.maskLinked}:${JSON.stringify(l.maskPlacement)}:${l.clipTo}:${JSON.stringify(l.transform)}:${l.adjustment ? JSON.stringify(l.adjustment) : ''}:${l.effects ? JSON.stringify(l.effects) : ''}:${l.canvas?.width}x${l.canvas?.height}:${anc}`;
  }
  private adjustedBackdrop(l: Layer, accum: Target, W: number, H: number, key: string): WebGLTexture {
    const gl = this.gl;
    const cached = this.adjCache.get(l.id);
    if (cached && cached.key === key) return cached.tex;
    gl.bindFramebuffer(gl.FRAMEBUFFER, accum.fbo);
    const raw = new Uint8Array(W * H * 4);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, raw);
    let img = new ImageData(W, H);
    unpremultiplyFrom(raw, 0, img.data);
    const f = adjustmentAsFilter(l.adjustment!);
    img = applyFilter(f.kind, f.settings, img, { seed: f.seed, scale: 1, originX: 0, originY: 0 });
    const tex = cached?.tex ?? gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, img);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.adjCache.set(l.id, { key, tex });
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return tex;
  }

  /** Draws the composite to the screen at `zoom` (screen px per doc px) with the doc's top-left at offset (CSS px). */
  present(doc: Doc, zoom: number, offX: number, offY: number, dpr: number, pixelGrid = true) {
    const gl = this.gl;
    if (!this.composite) return;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.disable(gl.BLEND);
    gl.useProgram(this.screenProg);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.composite.tex);
    const scale = zoom * dpr;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, scale < 1 ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, scale >= 2 ? gl.NEAREST : gl.LINEAR);
    const u = (n: string) => gl.getUniformLocation(this.screenProg, n);
    gl.uniform1i(u('u_tex'), 0);
    gl.uniform2f(u('u_screen'), this.canvas.width, this.canvas.height);
    gl.uniform2f(u('u_offset'), offX * dpr, offY * dpr);
    gl.uniform1f(u('u_scale'), scale);
    gl.uniform1f(u('u_dpr'), dpr);
    gl.uniform2f(u('u_docSize'), doc.width, doc.height);
    gl.uniform1i(u('u_pixelGrid'), pixelGrid && zoom >= 8 ? 1 : 0);
    gl.bindVertexArray(this.quad); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
  clearScreen() {
    const gl = this.gl; gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height); gl.clearColor(0.118, 0.118, 0.118, 1); gl.clear(gl.COLOR_BUFFER_BIT);
  }

  /** The flattened document, straight alpha (for export, the eyedropper and the Magic Wand). */
  readComposite(doc: Doc): ImageData {
    this.render(doc);
    const gl = this.gl, W = doc.width, H = doc.height;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.composite!.fbo);
    const raw = new Uint8Array(W * H * 4);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, raw);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const img = new ImageData(W, H);
    unpremultiplyFrom(raw, 0, img.data);
    return img;
  }
  readPixel(doc: Doc, x: number, y: number): [number, number, number, number] {
    this.render(doc);
    const gl = this.gl, out = new Uint8Array(4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.composite!.fbo);
    gl.readPixels(Math.floor(x), Math.floor(y), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, out);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const a = out[3];
    return a ? [Math.round(out[0] * 255 / a), Math.round(out[1] * 255 / a), Math.round(out[2] * 255 / a), a] : [0, 0, 0, 0];
  }
  forget(layerId: string) { this.texCache.delete('L' + layerId); this.texCache.delete('M' + layerId); }
  invalidate() { this.compositeKey = ''; }
}
export { apply, invert };
