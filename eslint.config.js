import js from '@eslint/js';
import tseslint from 'typescript-eslint';

// Browser globals used by the plain-JavaScript client in web/ (no bundler, no dependency for a globals list).
const browserGlobals = Object.fromEntries(
  [
    'window',
    'document',
    'navigator',
    'location',
    'history',
    'console',
    'fetch',
    'Headers',
    'Request',
    'Response',
    'AbortController',
    'URL',
    'URLSearchParams',
    'TextDecoder',
    'TextEncoder',
    'ReadableStream',
    'requestAnimationFrame',
    'cancelAnimationFrame',
    'setTimeout',
    'clearTimeout',
    'setInterval',
    'clearInterval',
    'localStorage',
    'sessionStorage',
    'crypto',
    'HTMLElement',
    'Blob',
    'Event',
    'CustomEvent',
    'KeyboardEvent',
    'MutationObserver',
    'IntersectionObserver',
  ].map((name) => [name, 'readonly']),
);

export default tseslint.config(
  { ignores: ['node_modules/', 'dist/', 'coverage/', 'data/', 'docs/', 'web/**/*.d.ts'] },
  js.configs.recommended,
  {
    files: ['**/*.ts', 'eslint.config.js'],
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ['eslint.config.js'] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    // The browser client is plain JavaScript: checked without type information.
    files: ['web/**/*.js'],
    languageOptions: { sourceType: 'module', globals: browserGlobals },
    rules: {
      eqeqeq: 'error',
      'no-var': 'error',
      'prefer-const': 'error',
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
);
