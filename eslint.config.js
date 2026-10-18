import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['node_modules/'] },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: globals.node,
    },
  },
  {
    // The screen scripts run in the browser.
    files: ['src/public/**/*.js'],
    languageOptions: {
      globals: globals.browser,
    },
  },
];
