// Flat ESLint config — TypeScript-aware via typescript-eslint.
// Type-checked rules are intentionally NOT enabled yet: there is no application
// code to type-check against. Issue #3 can switch to `recommendedTypeChecked`.
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/**', 'coverage/**', 'node_modules/**'],
  },
  ...tseslint.configs.recommended,
  {
    // Allow intentionally-unused, underscore-prefixed identifiers. Express's
    // error-handler middleware must declare four args (the trailing `next`)
    // for Express to recognise it as an error handler, and route handlers often
    // skip leading params like `_req`. The underscore marks these as deliberate.
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
    },
  },
);
