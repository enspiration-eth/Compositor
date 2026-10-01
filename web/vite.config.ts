import { defineConfig } from 'vite';

// GitHub Pages serves the fork at /<repo>/; BASE_PATH is set by the deploy workflow.
export default defineConfig({
  base: process.env.BASE_PATH ?? './',
  build: { target: 'es2022', outDir: 'dist', assetsInlineLimit: 0 },
  // Filter workers import the wasm module (which uses import.meta.url), so they are ES module workers.
  worker: { format: 'es' },
  server: { port: 5173 },
});
