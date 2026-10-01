export interface PixelsModule {
  HEAPU8: Uint8Array;
  HEAPF32: Float32Array;
  HEAPF64: Float64Array;
  HEAP32: Int32Array;
  HEAPU32: Uint32Array;
  [name: `_${string}`]: (...args: number[]) => number;
}
export default function createPixels(options?: Record<string, unknown>): Promise<PixelsModule>;
