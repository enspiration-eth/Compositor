import { defineConfig, type Plugin } from 'vite';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

// Emits dist/sw.js with this build's app shell list, so installs work offline and every deploy updates the cache.
// The HEIC decoder, the ONNX runtime and the models stay out of the precache (several MB); they're cached on first use.
function serviceWorker(): Plugin {
  return {
    name: 'photoshop-eth-sw', apply: 'build',
    generateBundle(_, bundle) {
      const files = Object.keys(bundle).filter(f => !/(libheif|ort[.-]|\.map$|\.onnx$)/.test(f) && f !== 'sw.js');
      const shell = ['./', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png', 'favicon-32.png', 'splash.jpg', ...files.filter(f => f !== 'index.html')];
      const version = createHash('sha256').update(shell.join('\n')).digest('hex').slice(0, 12);
      const src = readFileSync(new URL('./pwa/sw-template.js', import.meta.url), 'utf8')
        .replace('__VERSION__', version).replace('__PRECACHE__', JSON.stringify(shell, null, 1));
      this.emitFile({ type: 'asset', fileName: 'sw.js', source: src });
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
