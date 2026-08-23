// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import importX from 'eslint-plugin-import-x';
import vue from 'eslint-plugin-vue';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/coverage/**',
      '**/node_modules/**',
      '**/.turbo/**',
      'workspace/**',
      'docs/generated/**',
    ],
  },

  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        projectService: {
          // Root- and package-level tool configs are real TS but deliberately sit
          // outside every package's `include`. Without this they fail to parse and
          // `pnpm lint` reports "not found by the project service".
          allowDefaultProject: [
            '*.config.ts',
            '*.config.mts',
            'packages/*/*.config.ts',
            'apps/*/*.config.ts',
          ],
          // typescript-eslint caps the default project at 8 files and then refuses to
          // parse any of them. Every package ships a `tsup.config.ts` and a
          // `vitest.config.ts`, so the workspace crosses that line at five packages -
          // which turned into "Parsing error: Too many files" on every config file at
          // once. Raised rather than worked around: these are ~10-line files, and the
          // alternative is a per-package tsconfig that includes them purely to keep
          // the linter happy.
          maximumDefaultProjectFileMatchCount_THIS_WILL_SLOW_DOWN_LINTING: 60,
        },
        tsconfigRootDir: import.meta.dirname,
      },
      globals: { ...globals.node },
    },
    plugins: { 'import-x': importX },
    rules: {
      // --- correctness -------------------------------------------------
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': [
        'error',
        // A `default` clause is exhaustive handling. Requiring every union member on top
        // of it turns a deliberately open switch over a third-party union into noise.
        { considerDefaultExhaustiveForUnions: true },
      ],
      '@typescript-eslint/no-unnecessary-condition': 'warn',
      'no-console': ['error', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],

      // --- explicitness ------------------------------------------------
      '@typescript-eslint/explicit-module-boundary-types': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],

      // --- keep the layering honest (structural half; depcruise does the rest)
      'import-x/no-cycle': ['error', { maxDepth: 8 }],
      'import-x/no-self-import': 'error',

      // Escape hatches must be loud.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/ban-ts-comment': [
        'error',
        { 'ts-expect-error': 'allow-with-description' },
      ],
    },
  },

  // Vue SFCs
  ...vue.configs['flat/recommended'],
  {
    files: ['**/*.vue'],
    languageOptions: {
      parserOptions: {
        parser: tseslint.parser,
        extraFileExtensions: ['.vue'],
      },
      globals: { ...globals.browser },
    },
    rules: {
      'vue/multi-word-component-names': 'off',
      'vue/component-api-style': ['error', ['script-setup']],
      'vue/define-macros-order': 'error',
      'vue/block-order': ['error', { order: ['script', 'template', 'style'] }],
    },
  },

  // NestJS relies on parameter decorators and class-based DI.
  {
    files: ['apps/api/**/*.ts'],
    rules: {
      '@typescript-eslint/no-extraneous-class': 'off',
      '@typescript-eslint/consistent-type-imports': 'off',
    },
  },

  // Standalone CLI scripts under tools/ are not part of the typed program and print
  // to the terminal by design.
  {
    files: ['tools/**/*.{mjs,js,cjs}'],
    ...tseslint.configs.disableTypeChecked,
    rules: { 'no-console': 'off' },
  },

  // Tests may be looser about non-null assertions and console.
  {
    files: ['**/*.spec.ts', '**/*.test.ts', '**/test/**/*.ts', '**/__fixtures__/**/*.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/unbound-method': 'off',
      'no-console': 'off',
    },
  },

  {
    files: ['**/*.js', '**/*.mjs', '**/*.cjs'],
    ...tseslint.configs.disableTypeChecked,
  },

  prettier,
);
