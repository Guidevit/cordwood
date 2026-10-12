## Rules: enforced by the harness

Hooks in `.claude/hooks/` check every edit and every shell command. Prose asks, hooks refuse. The numbers are in `.claude/rules.json`.

| Rule | Limit |
|---|---|
| A function in a `.ts` file | 100 lines |
| A `.tsx` file | 500 lines |
| A route file (`src/app/**/route.ts`) | 300 lines |
| Parameters of a function | 6 |
| Cyclomatic complexity of a function | 15 |

- Every file under `src/server`, `src/lib` and `src/app` opens with a comment that starts `Reason to change:` and names the one kind of decision that would change it. A file with two reasons is two files.
- Every `.ts` file under `src/server` and `src/lib` has its test beside it (`name.test.ts`). Write the test first. `// @tdd-exempt: <reason>` marks a file with nothing to test, such as one that only builds a client.
- A commit that carries a secret or an env file other than `.env.development` and `.env.example` is refused.
- A command that deletes work for good, deploys, or reaches a Firebase project that is not `demo-*` asks you first.

When a hook answers `[BLOCK ...]`, fix the cause in the code. Do not work around it, and do not edit `.claude/rules.json`, `.claude/hooks/` or `eslint.limits.mjs`: those are changed by a person, with `HARNESS_UNLOCKED=1` in their own terminal.

`pnpm rules` runs the same checks over the whole of `src/`.
