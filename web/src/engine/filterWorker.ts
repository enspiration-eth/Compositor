// A filter worker: its own instance of the wasm kernels, running `applyFilter` on whatever strip of pixels it is sent.
// Pixels travel as transferred ArrayBuffers (no SharedArrayBuffer: GitHub Pages can't send the cross-origin isolation
// headers that wasm threads need).
import { loadKernels } from './kernels';
import { applyFilter, type ApplyContext, type FilterKind, type FilterSettings } from './adjustments';

const ready = loadKernels();
interface Job { id: number; kind: FilterKind; s: FilterSettings; ctx: ApplyContext; w: number; h: number; data: ArrayBuffer }
self.onmessage = async (e: MessageEvent<Job>) => {
  const { id, kind, s, ctx, w, h, data } = e.data;
  try {
    await ready;
    const out = applyFilter(kind, s, new ImageData(new Uint8ClampedArray(data), w, h), ctx);
    (self as unknown as Worker).postMessage({ id, w: out.width, h: out.height, data: out.data.buffer }, [out.data.buffer]);
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, error: String((err as Error)?.message ?? err) });
  }
};
