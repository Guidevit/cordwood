#!/usr/bin/env node
// Reason to change: which of the harness's own files an agent may not write.
//
// PreToolUse on Edit, Write and MultiEdit. The limits and the hooks that enforce them are fixed for an
// agent: a rule that the one it binds can loosen is a suggestion. A person changes them with
// HARNESS_UNLOCKED=1 in their own terminal. The wiring in settings.json is left out on purpose, since a
// removed hook is a visible line in a diff and a nudged threshold is not.
import { decide, payload, projectDir, relative } from "./lib.mjs";

const GATED = [/^\.claude\/rules\.json$/, /^\.claude\/hooks\//, /^eslint\.limits\.mjs$/];

try {
  const input = payload();
  const file = input?.tool_input?.file_path;
  if (typeof file !== "string" || process.env.HARNESS_UNLOCKED === "1") process.exit(0);
  const target = relative(projectDir(input), file);
  if (target && GATED.some((pattern) => pattern.test(target)))
    decide(
      "deny",
      `${target} is part of the harness and is changed by a person, with HARNESS_UNLOCKED=1 in their own terminal. Fix the code the rule points at.`,
    );
} catch {}
process.exit(0);
