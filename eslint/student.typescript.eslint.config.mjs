import globals from 'globals';
import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';

export default [
  {
    files: ['**/*.ts', '**/*.tsx'],
    ignores: ['**/node_modules/**', '**/dist/**', '**/build/**'],
    languageOptions: {
      parser: tsParser,
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.node
      }
    },
    plugins: {
      '@typescript-eslint': tsPlugin
    },
    linterOptions: {
      reportUnusedDisableDirectives: 'warn'
    },
    rules: {
      'no-undef': 'off', // TS's own type checking supersedes this; avoids false positives on types/interfaces
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
      'no-unreachable': 'error',
      'no-debugger': 'warn',
      'no-constant-condition': ['warn', { checkLoops: false }],
      eqeqeq: ['warn', 'always'],
      curly: ['warn', 'all'],
      semi: ['error', 'always'],
      'no-extra-semi': 'error',
      'comma-dangle': ['warn', 'never'],
      '@typescript-eslint/no-explicit-any': 'warn'
    }
  }
];
