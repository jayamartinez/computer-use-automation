import js from "@eslint/js";
import tseslint from "typescript-eslint";

// Import boundaries from AGENTS.md that are cheap to enforce mechanically.
const restrict = (files, patterns, message) => ({
  files,
  rules: { "no-restricted-imports": ["error", { patterns: [{ group: patterns, message }] }] },
});

export default tseslint.config(
  { ignores: ["node_modules", "dist", "runs", "test-results", "playwright-report", ".claude"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { varsIgnorePattern: "^_" }],
    },
  },
  restrict(["demo-app/**"], ["**/src/**"], "The demo app must never import automation code."),
  restrict(
    ["src/replay/**"],
    ["**/discovery/**", "**/compiler/**"],
    "Replay must not be able to reach model code.",
  ),
);
