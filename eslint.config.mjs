import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'dist', 'node_modules', 'coverage', 'development',
      'docs/.vitepress/cache', 'docs/.vitepress/dist',
      // CommonJS migrations and build config sit outside the TS project, so
      // the type-aware rules cannot parse them.
      'migrations/**', '*.config.mjs', 'docs/**', 'scripts/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // A floating promise in a worker loop silently drops work.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      // `any` erases the guarantees the zod schemas exist to provide.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/restrict-template-expressions': 'off',
      'no-console': ['error', { allow: ['error'] }],
      // Express identifies an error handler by ARITY: a 4-arg signature is
      // required even when `next` is unused, so leading-underscore args are
      // deliberately exempt.
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_',
      }],
    },
  },
  {
    // The CLI writes to stdout by design.
    files: ['src/cli/**', 'scripts/**'],
    rules: { 'no-console': 'off' },
  },
  {
    // Tests deliberately construct malformed input and poke at internals, so
    // the type-safety rules that protect production code get in the way here.
    // The rules that catch REAL test bugs — floating promises above all — stay on.
    files: ['tests/**'],
    rules: {
      'no-console': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-base-to-string': 'off',
      '@typescript-eslint/no-unnecessary-type-assertion': 'off',
      '@typescript-eslint/unbound-method': 'off',
    },
  },
);
