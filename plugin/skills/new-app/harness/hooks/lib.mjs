// Reason to change: how a hook reads its payload, finds the project, matches a path and answers Claude Code.
import { readFileSync } from "node:fs";
import path from "node:path";

/** The payload Claude Code hands a hook on stdin, or null for anything unreadable. */
export function payload() {
  try {
    return JSON.parse(readFileSync(0, "utf8"));
  } catch {
    return null;
  }
}

export const projectDir = (input) => process.env.CLAUDE_PROJECT_DIR || input?.cwd || process.cwd();

export function rules(root) {
  return JSON.parse(readFileSync(path.join(root, ".claude", "rules.json"), "utf8"));
}

/** `file` relative to the project with forward slashes, or null when it is outside it. */
export function relative(root, file) {
  const rel = path.relative(root, path.resolve(root, file));
  return rel.startsWith("..") || path.isAbsolute(rel) ? null : rel.split(path.sep).join("/");
}

/** Whether `file` matches a pattern where `**` crosses folders and `*` stays inside one. */
export function matches(file, pattern) {
  const source = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*\/?/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\u0000/g, ".*");
  return new RegExp(`^${source}$`).test(file);
}

export const matchesAny = (file, patterns) => patterns.some((pattern) => matches(file, pattern));

/** Answers a PreToolUse hook: "ask" leaves the choice to the person, "deny" refuses. */
export function decide(permissionDecision, reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision,
        permissionDecisionReason: reason,
      },
    }),
  );
  process.exit(0);
}
