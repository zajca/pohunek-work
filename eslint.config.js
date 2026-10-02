import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["node_modules/**", "dist/**", "logs/**"] },
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/explicit-module-boundary-types": "error",
      "@typescript-eslint/explicit-function-return-type": [
        "error",
        { allowExpressions: true, allowTypedFunctionExpressions: true },
      ],
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/restrict-template-expressions": [
        "error",
        { allowNumber: true },
      ],
    },
  },
  {
    // The TUI consumes the list/do contracts through child processes only
    // (docs/tui-plan.md 4.1): no pipeline, source or action module may be imported.
    files: ["src/tui/**/*.ts", "src/commands/tui.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              regex:
                "^\\.\\./(?!(types/item|types/config|actions/types|log|util/exec|paths|output/sanitize|output/drafts)\\.ts$|config/|tui/)",
              message:
                "the TUI may import only types/item.ts, types/config.ts, actions/types.ts, log.ts, util/exec.ts, paths.ts, output/sanitize.ts, output/drafts.ts, config/ and tui/",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["eslint.config.js"],
    extends: [tseslint.configs.disableTypeChecked],
  },
);
