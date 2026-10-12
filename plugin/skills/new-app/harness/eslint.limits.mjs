// Reason to change: which size and complexity limits ESLint enforces, and on which files.
// The numbers live in .claude/rules.json, the one place they are set.
import { readFileSync } from "node:fs";

const { limits } = JSON.parse(readFileSync(new URL("./.claude/rules.json", import.meta.url), "utf8"));
const counted = { skipBlankLines: true, skipComments: true };

export default [
  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/components/ui/**"],
    rules: { "max-params": ["error", limits.params], complexity: ["error", limits.complexity] },
  },
  {
    // A component's function is its whole markup, so a .tsx file is held by the file limit below.
    files: ["src/**/*.ts"],
    ignores: ["src/**/*.test.ts"],
    rules: { "max-lines-per-function": ["error", { max: limits.functionLines, ...counted }] },
  },
  {
    files: ["src/**/*.tsx"],
    ignores: ["src/components/ui/**"],
    rules: { "max-lines": ["error", { max: limits.componentLines, ...counted }] },
  },
  {
    files: ["src/app/**/route.ts"],
    rules: { "max-lines": ["error", { max: limits.routeLines, ...counted }] },
  },
];
