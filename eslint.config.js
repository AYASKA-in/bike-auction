import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/.wrangler/**",
      "**/node_modules/**",
      "**/worker-configuration.d.ts",
      "**/routeTree.gen.ts",
      "apps/worker/scripts/**",
      "scripts/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/consistent-type-imports": "error",
      eqeqeq: ["error", "always"],
      "no-console": "off",
    },
  },
  {
    files: ["apps/web/**/*.{ts,tsx}"],
    languageOptions: { globals: globals.browser },
    plugins: { "react-hooks": reactHooks },
    rules: reactHooks.configs.recommended.rules,
  },
  {
    files: ["**/*.config.{js,ts}", "apps/worker/scripts/**/*.mjs"],
    languageOptions: { globals: globals.node },
  },
);
