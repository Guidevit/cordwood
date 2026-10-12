#!/usr/bin/env node
// Reason to change: which shell commands a person confirms first, which are refused, and what counts as a secret.
//
// PreToolUse on Bash. Three answers:
//   deny  a commit that would carry a secret or an env file, and a shell write to the harness's own files
//   ask   a command that destroys local work or reaches a real cloud project
//   (silence) everything else
//
// It fails open: on a payload it cannot read or an error of its own, the command runs. A guard that
// strands the agent is worse than no guard.
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { decide, payload, projectDir, rules } from "./lib.mjs";

const SECRETS = [
  [/\bsk_(live|test)_[0-9A-Za-z]{16,}/, "a Stripe secret key"],
  [/\brk_(live|test)_[0-9A-Za-z]{16,}/, "a Stripe restricted key"],
  [/\bwhsec_[0-9A-Za-z]{16,}/, "a Stripe webhook secret"],
  [/\bSG\.[\w-]{16,}\.[\w-]{16,}/, "a SendGrid key"],
  [/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, "a private key"],
  [/\bgh[pousr]_[0-9A-Za-z]{30,}/, "a GitHub token"],
  [/\bxox[abprs]-[0-9A-Za-z-]{10,}/, "a Slack token"],
];

const HARNESS = String.raw`[^\s;&|<>]*(?:\.claude\/(?:rules\.json|hooks\/)|eslint\.limits\.mjs)`;
// A harness file as the target of a redirect, or anywhere in a command that changes files.
const WRITES_HARNESS = new RegExp(
  String.raw`>>?\s*["']?${HARNESS}|(?:^|[\s;&|])(?:rm|mv|cp|tee|truncate|chmod|sed\s+-i\S*|perl\s+-\S*i\S*)\s[^;&|]*${HARNESS}`,
);

const git = (root, args) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });

/** What a commit made now would carry that must never reach a repository. */
function leaks(root, allowedEnv) {
  const found = [];
  const changed = git(root, ["status", "--porcelain", "--untracked-files=all"])
    .split("\n")
    .filter((line) => line && !line.startsWith(" D") && !line.startsWith("D "))
    .map((line) => line.slice(3).replace(/^"|"$/g, "").split(" -> ").pop());
  for (const file of changed) {
    const name = path.basename(file);
    if (/^\.env(\..+)?$/.test(name) && !allowedEnv.includes(name)) found.push(`${file} is an env file`);
  }
  const added = git(root, ["diff", "HEAD", "-U0"])
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"));
  const untracked = git(root, ["ls-files", "--others", "--exclude-standard"]).split("\n").filter(Boolean);
  for (const file of untracked) {
    try {
      if (statSync(path.join(root, file)).size < 200_000)
        added.push(...readFileSync(path.join(root, file), "utf8").split("\n"));
    } catch {}
  }
  for (const [pattern, name] of SECRETS)
    if (added.some((line) => pattern.test(line))) found.push(`the change holds ${name}`);
  return found;
}

/** The targets of every `rm -rf` in the command that are not a build folder or under a temp root. */
function unsafeDeletes(command, safe) {
  const targets = [];
  for (const segment of command.split(/&&|\|\||[;|\n]/)) {
    const words = segment.trim().split(/\s+/);
    if (words[0] === "sudo") words.shift();
    if (words[0] !== "rm") continue;
    const flags = words.filter((word) => /^-[a-zA-Z]+$/.test(word)).join("");
    const long = words.filter((word) => word.startsWith("--"));
    const recursive = /[rR]/.test(flags) || long.includes("--recursive");
    const forced = flags.includes("f") || long.includes("--force");
    if (!recursive || !forced) continue;
    for (const target of words.slice(1).filter((word) => !word.startsWith("-"))) {
      const clean = target.replace(/^["']|["']$/g, "").replace(/\/+$/, "");
      const temp = /^(\/private)?\/tmp\/[^/]/.test(clean) && !clean.includes("..");
      const build = safe.includes(path.basename(clean)) && !clean.includes("..") && !/[*$~]/.test(clean);
      if (!temp && !build) targets.push(target);
    }
  }
  return targets;
}

/** Why a person should confirm this command, or null. */
function risk(command, safe) {
  const deletes = unsafeDeletes(command, safe);
  if (deletes.length > 0) return `it deletes ${deletes.join(", ")} for good`;
  if (/\bgit\s+reset\s+--hard\b/.test(command)) return "it throws away uncommitted work";
  if (/\bgit\s+(checkout|restore)\s+(--\s+)?\.(\s|$)/.test(command)) return "it throws away uncommitted work";
  if (/\bgit\s+branch\s+-D\b/.test(command)) return "it deletes a branch that may hold unmerged work";
  if (/\bfirebase\s+(deploy|firestore:delete|auth:import|hosting:disable)\b/.test(command))
    return "it changes a real Firebase project";
  const project = /--project[=\s]+["']?([\w-]+)/.exec(command)?.[1];
  if (/\b(firebase|gcloud)\b/.test(command) && project && !project.startsWith("demo-"))
    return `it reaches the real project ${project}`;
  if (/\bgh\s+repo\s+create\b/.test(command) && /--public\b/.test(command))
    return "it creates a public repository";
  if (/\b(npm|pnpm|yarn)\s+publish\b/.test(command)) return "it publishes a package";
  return null;
}

try {
  const input = payload();
  const command = input?.tool_name === "Bash" ? input.tool_input?.command : null;
  if (typeof command !== "string" || !command.trim()) process.exit(0);
  const root = projectDir(input);
  const config = rules(root);

  if (WRITES_HARNESS.test(command) && process.env.HARNESS_UNLOCKED !== "1")
    decide(
      "deny",
      "The harness's limits and hooks are changed by a person, with HARNESS_UNLOCKED=1 in their own terminal. Fix the code the rule points at.",
    );

  if (/\bgit\s+commit\b/.test(command)) {
    const found = leaks(root, config.envFilesAllowed ?? []);
    if (found.length > 0)
      decide(
        "deny",
        `This commit must not go: ${found.join("; ")}. Move the value to .env.local, which git ignores, and commit again.`,
      );
  }

  // Someone who chose to run with no prompts is not prompted by a hook either.
  if (input.permission_mode === "bypassPermissions") process.exit(0);
  const reason = risk(command, config.safeToDelete ?? []);
  if (reason) decide("ask", `Confirm before this runs: ${reason}.`);
} catch {}
process.exit(0);
