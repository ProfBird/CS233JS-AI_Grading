export default [
  {
    files: ['**/*.js'],
    ignores: ['**/node_modules/**', '**/dist/**', '**/build/**'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        window: 'readonly',
        document: 'readonly',
        console: 'readonly',
        process: 'readonly',
        module: 'readonly',
        require: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        alert: 'readonly',
        confirm: 'readonly',
        prompt: 'readonly'
      }
    },
    linterOptions: {
      reportUnusedDisableDirectives: 'warn'
    },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      'no-unreachable': 'error',
      'no-debugger': 'warn',
      'no-constant-condition': ['warn', { checkLoops: false }],
      eqeqeq: ['warn', 'always'],
      curly: ['warn', 'all'],
      semi: ['error', 'always'],
      'no-extra-semi': 'error',
      'comma-dangle': ['warn', 'never']
    }
  }
];
