import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import simpleImportSort from "eslint-plugin-simple-import-sort";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    // tests/support/forge-contract/ holds forge's client contracts as they came and what the
    // generator wrote from them: compared byte for byte (tests/codegen/generation.test.ts), never rewritten
    // by a formatter.
    ignores: ["**/dist/**", "**/node_modules/**", "tests/support/forge-contract/**"],
  },
  js.configs.recommended,
  tseslint.configs.recommended,
  prettier,
  {
    plugins: { "simple-import-sort": simpleImportSort },
    rules: {
      "simple-import-sort/imports": "error",
      "simple-import-sort/exports": "error",
      "@typescript-eslint/consistent-type-imports": "error",
      // The same rule tsc applies with noUnusedParameters: a leading `_` says "unused on
      // purpose".
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", ignoreRestSiblings: true },
      ],
    },
  },
);
