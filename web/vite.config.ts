import { defineConfig, type Plugin } from 'vite';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

/** Emits sw.js (from sw-template.js) with the build's app shell to precache: every bundle file except the big,
 *  optional ones that load on demand (onnxruntime, libheif), which the worker caches the first time they're used. */
function serviceWorker(): Plugin {
  return {
    name: 'photoshop-eth-sw',
    apply: 'build',
    generateBundle(_options, bundle) {
      const all = Object.keys(bundle).filter(f => !f.endsWith('.map'));
      const lazy = (f: string) => /ort[-.]|onnxruntime|libheif|\.onnx$/i.test(f) || ((bundle[f] as { source?: { length: number } }).source?.length ?? 0) > 4_000_000;
      const shell = ['./', 'manifest.webmanifest', 'favicon-32.png', 'apple-touch-icon.png', 'icon-192.png', 'icon-512.png', 'splash.jpg',
        ...all.filter(f => !lazy(f) && f !== 'index.html')];
      const version = createHash('sha256').update(all.sort().join('\n')).digest('hex').slice(0, 12);
      const source = readFileSync(new URL('./sw-template.js', import.meta.url), 'utf8')
        .replace('__VERSION__', JSON.stringify(version)).replace('__PRECACHE__', JSON.stringify(shell)).replace('__KNOWN__', JSON.stringify(all));
      this.emitFile({ type: 'asset', fileName: 'sw.js', source });
    },
  };
}

// GitHub Pages serves the fork at /<repo>/; BASE_PATH is set by the deploy workflow.
export default defineConfig({
  base: process.env.BASE_PATH ?? './',
  build: { target: 'es2022', outDir: 'dist', assetsInlineLimit: 0 },
  // Filter workers import the wasm module (which uses import.meta.url), so they are ES module workers.
  worker: { format: 'es' },
  server: { port: 5173 },
  plugins: [serviceWorker()],
});
