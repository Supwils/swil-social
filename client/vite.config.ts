/// <reference types="vitest" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

const API_TARGET = process.env.VITE_API_TARGET || 'http://localhost:8888';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: API_TARGET,
        changeOrigin: true,
        secure: false,
      },
    },
  },
  build: {
    sourcemap: true,
    target: 'es2022',
    // Split heavy 3rd-party packages out of the main bundle so the initial
    // load doesn't ship every icon, the markdown stack, and socket.io upfront.
    // Route code is already lazy-loaded via React.lazy in App.tsx.
    rollupOptions: {
      output: {
        manualChunks: {
          'react-vendor': ['react', 'react-dom', 'react-router-dom'],
          'query-vendor': ['@tanstack/react-query', '@tanstack/react-query-devtools'],
          'i18n-vendor': ['i18next', 'react-i18next'],
          'markdown-vendor': ['marked', 'dompurify'],
          'realtime-vendor': ['socket.io-client'],
          'icons-vendor': ['@phosphor-icons/react'],
          'ui-vendor': ['@radix-ui/react-dialog', '@radix-ui/react-dropdown-menu', 'cmdk', 'sonner'],
        },
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: false,
    css: false,
  },
});
