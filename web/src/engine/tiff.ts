// TIFF (and TIFF-based camera RAW: DNG, NEF, CR2, ARW…) import, plus TIFF export.
// The Mac app reads these through ImageIO; browsers can't, so we decode with UTIF (MIT, pure JS).
import { canvasOf, ctx2d } from './adjustments';

type Ifd = Record<string, any> & { width: number; height: number; data?: Uint8Array };
let utifP: Promise<any> | null = null;
const utif = () => (utifP ??= import('utif').then(m => (m as any).default ?? m));

export const TIFF_RE = /\.(tiff?|dng|nef|nrw|cr2|arw|srw|orf|rw2|pef|raf|3fr|erf|kdc|mef|mos|raw|rwl|iiq)$/i;
export function isTiffName(name: string, type = '') { return TIFF_RE.test(name) || /image\/(tiff|x-.*raw|x-adobe-dng)/i.test(type); }

/** Decode the largest image in a TIFF/RAW file into a canvas. */
export async function tiffToCanvas(buf: ArrayBuffer): Promise<HTMLCanvasElement> {
  const U = await utif();
  const ifds: Ifd[] = U.decode(buf);
  // Collect main IFDs plus sub-IFDs (DNG/raw keep the full-size image in t330).
  const all: Ifd[] = [];
  const visit = (l: Ifd[]) => { for (const f of l) { all.push(f); if (f.subIFD) visit(f.subIFD); } };
  visit(ifds);
  const cands = all.filter(f => f.t256 && f.t257).sort((a, b) => b.t256[0] * b.t257[0] - a.t256[0] * a.t257[0]);
  let lastErr: unknown = null;
  for (const f of cands) {
    try {
      U.decodeImage(buf, f, ifds);
      if (!f.width || !f.height || !f.data) continue;
      const rgba: Uint8Array = U.toRGBA8(f);
      if (rgba.length < f.width * f.height * 4) continue;
      // UTIF hands back raw sensor data (CFA) for some RAWs; skip mosaic images (photometric 32803) in favour of a preview.
      if (f.t262 && f.t262[0] === 32803) continue;
      const c = canvasOf(f.width, f.height);
      ctx2d(c).putImageData(new ImageData(new Uint8ClampedArray(rgba.buffer as ArrayBuffer, rgba.byteOffset, f.width * f.height * 4), f.width, f.height), 0, 0);
      return c;
    } catch (e) { lastErr = e; }
  }
  // Fall back to the largest embedded JPEG preview (most RAW files carry one).
  const jpeg = largestEmbeddedJpeg(new Uint8Array(buf));
  if (jpeg) {
    const bmp = await createImageBitmap(new Blob([jpeg as Uint8Array<ArrayBuffer>], { type: 'image/jpeg' }));
    const c = canvasOf(bmp.width, bmp.height); ctx2d(c).drawImage(bmp, 0, 0); return c;
  }
  throw lastErr instanceof Error ? lastErr : new Error('This TIFF/RAW file could not be decoded.');
}

function largestEmbeddedJpeg(b: Uint8Array): Uint8Array | null {
  let best: [number, number] | null = null;
  for (let i = 0; i < b.length - 3; i++) {
    if (b[i] !== 0xff || b[i + 1] !== 0xd8 || b[i + 2] !== 0xff) continue;
    // find matching EOI by walking markers until SOS, then scan for FFD9
    let j = i + 2, ok = false;
    while (j < b.length - 4 && b[j] === 0xff) {
      const m = b[j + 1], len = (b[j + 2] << 8) | b[j + 3];
      if (m === 0xda) { ok = true; j += 2 + len; break; }
      j += 2 + len;
    }
    if (!ok) continue;
    while (j < b.length - 1 && !(b[j] === 0xff && b[j + 1] === 0xd9)) j++;
    const end = j + 2;
    if (!best || end - i > best[1] - best[0]) best = [i, end];
    i = end - 1;
  }
  return best && best[1] - best[0] > 4096 ? b.subarray(best[0], best[1]) : null;
}

export async function canvasToTiff(img: ImageData): Promise<Uint8Array> {
  const U = await utif();
  return new Uint8Array(U.encodeImage(img.data, img.width, img.height));
}
