// @ts-check
import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      ".worktrees/",
      "**/node_modules/",
      "**/dist/",
      "**/build/",
      "**/coverage/",
      "**/.aws-sam/",
      "spikes/**/out/",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: { ...globals.node },
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": ["error", { fixStyle: "inline-type-imports" }],
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
  {
    files: ["apps/web/**/*.{ts,tsx}"],
    languageOptions: { globals: { ...globals.browser } },
  },
  { ...reactHooks.configs.flat.recommended, files: ["apps/web/**/*.{ts,tsx}"] },
  {
    // CLAUDE.md rule 3: the agent and tools packages read time from an injected Clock, so evals can freeze it.
    // Parsing a stored value (`new Date(iso)`) is fine; only the two Clock implementations read the real clock.
    files: ["packages/agent/src/**/*.ts", "packages/tools/src/**/*.ts"],
    ignores: ["packages/agent/src/ports.ts", "packages/tools/src/clock.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "NewExpression[callee.name='Date'][arguments.length=0], CallExpression[callee.object.name='Date'][callee.property.name='now']",
          message: "Read the time from an injected Clock (CLAUDE.md rule 3), not the real clock.",
        },
      ],
    },
  },
  prettier,
);
