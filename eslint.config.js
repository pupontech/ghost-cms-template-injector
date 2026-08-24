import eslint from '@typescript-eslint/eslint-plugin';
import parser from '@typescript-eslint/parser';

export default [
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', '.worktrees/**'],
  },
  {
    files: ['src/**/*.ts', 'tests/**/*.ts', 'scripts/**/*.mjs'],
    languageOptions: {
      parser,
      parserOptions: { sourceType: 'module', ecmaVersion: 'latest' },
    },
    plugins: { '@typescript-eslint': eslint },
    rules: {
      ...eslint.configs.recommended.rules,
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      eqeqeq: 'error',
      'no-console': 'off',
    },
  },
];
