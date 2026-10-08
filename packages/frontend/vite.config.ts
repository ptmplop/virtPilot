import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  // noVNC uses top-level await, which esbuild's dep pre-bundler can't handle.
  // Exclude it so it's transformed on demand (only when the console opens) and
  // bump the pre-bundle target to allow TLA elsewhere.
  optimizeDeps: {
    exclude: ['@novnc/novnc'],
    esbuildOptions: { target: 'esnext' },
  },
  server: {
    port: 5174,
    strictPort: true,
    // changeOrigin stays off: the backend's same-origin check compares the Origin's
    // hostname with Host. Rewriting Host to "localhost" rejected every write made from
    // http://127.0.0.1:5174 with "Origin not allowed" (reads still worked, so it looked
    // like a flaky save). Passing the browser's own Host through matches either name.
    proxy: {
      '/api': { target: 'http://localhost:3001', changeOrigin: false },
      '/ws': { target: 'ws://localhost:3001', changeOrigin: false, ws: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    target: 'esnext',
  },
});
