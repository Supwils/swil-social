// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        __dirname: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        setImmediate: 'readonly',
      },
    },
    rules: {
      // Allow `_`-prefixed unused vars (intentional, common in catch blocks)
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      // The codebase relies on `unknown` casts at API boundaries — `any` is forbidden
      '@typescript-eslint/no-explicit-any': 'error',
      // Allow non-null assertions in tests; tighten elsewhere
      '@typescript-eslint/no-non-null-assertion': 'off',
      // Empty catch blocks are common for fire-and-forget telemetry / cleanup
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    // Test files: relax a few rules
    files: ['**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
);
