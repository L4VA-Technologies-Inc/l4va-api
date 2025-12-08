const js = require('@eslint/js');
const globals = require('globals');
const prettier = require('eslint-plugin-prettier');
const tseslint = require('typescript-eslint');
const importPlugin = require('eslint-plugin-import');

module.exports = tseslint.config(
  { ignores: ['dist', 'node_modules', 'coverage'] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      globals: {
        ...globals.node,
        ...globals.jest,
      },
      parserOptions: {
        project: './tsconfig.json',
      },
    },
    plugins: {
      prettier,
      import: importPlugin,
    },
    rules: {
      'import/order': [
        'error',
        {
          groups: ['builtin', 'external', 'internal', 'parent', 'sibling', 'index'],
          'newlines-between': 'always',
          alphabetize: {
            order: 'asc',
            caseInsensitive: true,
          },
        },
      ],
      'import/no-duplicates': 'error',
      'prettier/prettier': [
        'error',
        {
          singleQuote: true,
          // Ensure imports and strings use single quotes
          // (Prettier already does this; ESLint enforces it too)
          // See additional 'quotes' rule below
          trailingComma: 'es5',
          printWidth: 120,
          tabWidth: 2,
          semi: true,
          arrowParens: 'avoid',
          endOfLine: 'lf',
          bracketSpacing: true,
        },
      ],
      quotes: ['error', 'single', { avoidEscape: true, allowTemplateLiterals: true }],
      '@typescript-eslint/explicit-function-return-type': 'warn',
      '@typescript-eslint/explicit-module-boundary-types': 'warn',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          caughtErrors: 'all',
          // allow exactly `catch (error)` to be unused
          caughtErrorsIgnorePattern: '^error$',
        },
      ],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  }
);
