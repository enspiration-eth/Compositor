// Filters off the main thread, split across a pool of Web Workers. The Mac app runs its kernels with dispatch_apply
// over all cores; here each worker holds its own copy of the wasm module and gets a strip of rows (plus, for the
// blurs, enough rows above and below that the strip's own rows come out exactly as they would from the whole image).
// Kinds that need the whole image at once (lens warp, vignette, Camera Raw's optics and geometry) run in one worker,
// and Dither, which draws glyphs with canvas text, stays on the main thread.
import { applyFilter, type ApplyContext, type FilterKind, type FilterSettings } from './adjustments';

type Pending = { resolve: (img: ImageData) => void; reject: (e: Error) => void };
const POINTWISE = new Set<FilterKind>(['Levels', 'Curves', 'Hue/Saturation', 'Exposure', 'Gradient Map', 'Black & White', 'Color Balance', 'Grain', 'Invert', 'Add Noise']);
const MAIN_THREAD = new Set<FilterKind>(['Dither', 'Content-Aware Fill', 'Remove Background']);

let workers: Worker[] | null = null, broken = false, nextId = 1, rr = 0;
const pending = new Map<number, Pending>();

export function poolSize() {
  const cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 4 : 4;
  return Math.max(1, Math.min(8, cores - 1));
}
function pool(): Worker[] | null {
  if (broken || typeof Worker === 'undefined') return null;
  if (workers) return workers;
  try {
    workers = Array.from({ length: poolSize() }, () => {
      const w = new Worker(new URL('./filterWorker.ts', import.meta.url), { type: 'module' });
      w.onmessage = (e: MessageEvent<{ id: number; w: number; h: number; data?: ArrayBuffer; error?: string }>) => {
        const p = pending.get(e.data.id); if (!p) return;
        pending.delete(e.data.id);
        if (e.data.error || !e.data.data) p.reject(new Error(e.data.error ?? 'filter worker failed'));
        else p.resolve(new ImageData(new Uint8ClampedArray(e.data.data), e.data.w, e.data.h));
      };
      // A worker that can't start (no module workers, blocked script): stop using the pool, finish on the main thread.
      w.onerror = ev => { ev.preventDefault?.(); broken = true; for (const [id, p] of pending) { pending.delete(id); p.reject(new Error('worker unavailable')); } };
      return w;
    });
    return workers;
  } catch { broken = true; return null; }
}
function post(w: Worker, kind: FilterKind, s: FilterSettings, ctx: ApplyContext, img: ImageData): Promise<ImageData> {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    const data = img.data.buffer;
    w.postMessage({ id, kind, s, ctx, w: img.width, h: img.height, data }, [data]);
  });
}

/** Stops the idle workers (each holds its own wasm heap); the next filter starts them again. */
export function releaseFilterPool() {
  if (!workers || pending.size) return;
  for (const w of workers) w.terminate();
  workers = null;
}

/** Rows a strip needs above and below its own so that neighborhood filters see what they would in the whole image. */
function halo(kind: FilterKind, s: FilterSettings, ctx: ApplyContext): number | null {
  if (POINTWISE.has(kind)) return 0;
  switch (kind) {
    case 'Gaussian Blur': return Math.ceil(s.radius * ctx.scale * 3) + 2;
    case 'Bloom / Glow': return Math.ceil(s.bloomRadius * ctx.scale * 3) + 2;
    case 'Tonal Contrast': return Math.ceil(s.tonalRadius * ctx.scale * 3) + 2;
    case 'Motion Blur': return Math.ceil(s.distance * ctx.scale / 2 * Math.abs(Math.sin(s.angle * Math.PI / 180))) + 2;
    default: return null;
  }
}

/** `applyFilter`, off the main thread and in parallel where the filter allows. Falls back to running it here. */
export async function applyFilterAsync(kind: FilterKind, s: FilterSettings, img: ImageData, ctx: ApplyContext): Promise<ImageData> {
  const ws = MAIN_THREAD.has(kind) ? null : pool();
  if (!ws) return applyFilter(kind, s, img, ctx);
  const plain = JSON.parse(JSON.stringify(s)) as FilterSettings;
  const { width: W, height: H } = img;
  const pad = halo(kind, s, ctx);
  try {
    const strips = pad === null ? 1 : Math.max(1, Math.min(ws.length, Math.floor(H / Math.max(64, pad * 2))));
    if (strips <= 1) return await post(ws[rr++ % ws.length], kind, plain, ctx, new ImageData(new Uint8ClampedArray(img.data), W, H));
    const rowBytes = W * 4, out = new ImageData(W, H);
    await Promise.all(Array.from({ length: strips }, (_, i) => {
      const y0 = Math.floor(H * i / strips), y1 = Math.floor(H * (i + 1) / strips);
      const b0 = Math.max(0, y0 - pad!), b1 = Math.min(H, y1 + pad!);
      const part = new ImageData(img.data.slice(b0 * rowBytes, b1 * rowBytes), W, b1 - b0);
      // Position-seeded noise and grain continue where the strip sits in the image.
      const c: ApplyContext = { ...ctx };
      if (kind === 'Add Noise') c.originY = (ctx.originY ?? 0) + b0;
      if (kind === 'Grain') c.originY = (ctx.originY ?? 0) + b0 / ctx.scale;
      return post(ws[(rr + i) % ws.length], kind, plain, c, part).then(r => {
        out.data.set(r.data.subarray((y0 - b0) * rowBytes, (y1 - b0) * rowBytes), y0 * rowBytes);
      });
    }));
    rr += strips;
    return out;
  } catch (e) {
    console.warn('filter workers unavailable; running on the main thread', e);
    return applyFilter(kind, s, img, ctx);
  }
}
