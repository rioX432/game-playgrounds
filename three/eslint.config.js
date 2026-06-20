// @ts-check
import tseslint from "typescript-eslint";

// typescript-eslint bundles the eslint base config, so no separate
// @eslint/js dependency is needed.
export default tseslint.config(
  {
    ignores: ["dist/**", "node_modules/**"],
  },
  ...tseslint.configs.recommended,
);
