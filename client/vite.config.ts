/// <reference types="vitest" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

const API_TARGET = process.env.VITE_API_TARGET || 'http://localhost:7945';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5947,
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
          'ui-vendor': ['@radix-ui/react-dialog', '@radix-ui/react-dropdown-menu', 'sonner'],
        },
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: false,
    css: false,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'json-summary'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        'src/**/*.test.{ts,tsx}',
        'src/main.tsx', // bootstrap
        'src/i18n.ts',  // pure config
        'src/locales/**',
        'src/api/types.ts',     // type-only
        'src/api/queryKeys.ts', // type-only
      ],
      // True baseline (2026-04-27, all files counted): ~4% lines / ~2% branches.
      // The client side is mostly untested today — these floors prevent
      // *regression* and are meant to be ratcheted up monthly. Targets:
      // 30% by next month, 60% by EOY, 80% before public launch.
      // Don't lower without a written reason in the commit message.
      thresholds: {
        lines: 4,
        branches: 1,
        functions: 2,
        statements: 3,
      },
    },
  },
});
