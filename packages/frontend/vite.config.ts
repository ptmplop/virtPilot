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
    proxy: {
      '/api': { target: 'http://localhost:3001', changeOrigin: true },
      '/ws': { target: 'ws://localhost:3001', changeOrigin: true, ws: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    target: 'esnext',
  },
});
