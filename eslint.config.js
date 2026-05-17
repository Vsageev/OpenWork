import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import globals from 'globals';

export default tseslint.config(
  { ignores: ['**/dist/', '**/node_modules/', '**/coverage/'] },

  // Base config for all TS files
  js.configs.recommended,
  ...tseslint.configs.recommended,

  // Backend files
  {
    files: ['packages/backend/src/**/*.ts'],
    languageOptions: {
      globals: globals.node,
    },
  },

  // Frontend files
  {
    files: ['packages/{frontend,landing}/src/**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    languageOptions: {
      globals: globals.browser,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
    },
  },

  // Shared files
  {
    files: ['packages/shared/src/**/*.ts'],
    languageOptions: {
      globals: globals.node,
    },
  },
);
