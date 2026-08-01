/// <reference types="vitest" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

const API_TARGET = process.env.VITE_API_TARGET || 'http://127.0.0.1:8899';

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
          'query-vendor': ['@tanstack/react-query'],
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
      // Ratchet log — raise these whenever coverage rises, never lower them
      // without a written reason in the commit message.
      //
      //   2026-04-27  4 / 1 / 2 / 3   baseline, with a stated plan of "30% by
      //                               next month". That did not happen: three
      //                               months later the floors were untouched
      //                               and the gate had stopped meaning anything.
      //   2026-07-31  6 / 5 / 5 / 6.5 lifted to just under the measured
      //                               7.02 lines / 5.82 branches / 5.72 funcs /
      //                               6.77 stmts after covering formatDate,
      //                               applyTheme and the draft store.
      //
      // The gap to a real gate is the routes tree (1.2% — lab.tsx, settings,
      // post, user, notifications are all at 0) and the feature components.
      // Those need render tests, not more unit tests on pure helpers.
      thresholds: {
        lines: 6.5,
        branches: 5,
        functions: 5,
        statements: 6,
      },
    },
  },
});
