// Flat ESLint config — TypeScript-aware via typescript-eslint.
// Type-checked rules are intentionally NOT enabled yet: there is no application
// code to type-check against. Issue #3 can switch to `recommendedTypeChecked`.
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/**', 'coverage/**', 'node_modules/**'],
  },
  ...tseslint.configs.recommended,
);
