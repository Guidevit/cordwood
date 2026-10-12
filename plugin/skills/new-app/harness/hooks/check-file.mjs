#!/usr/bin/env node
// Reason to change: what a source file must have (a header, a test beside it, a size within the limits) and how a miss is reported.
//
// Two ways in:
//   PostToolUse on Edit, Write and MultiEdit: checks the one file just written and, on a miss, exits 2
//   with the reasons on stderr, which Claude Code hands back to the agent.
//   `node .claude/hooks/check-file.mjs --all`: checks every file under src/ and exits 1 on a miss. For
//   CI, and for the session that installed the harness, where the hooks are not live yet.
//
// As a hook it fails open: an error of its own never blocks an edit.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { matchesAny, payload, projectDir, relative, rules } from "./lib.mjs";

const LIMIT_RULES = new Set(["max-lines-per-function", "max-lines", "max-params", "complexity"]);
const isTest = (file) => /\.test\.tsx?$/.test(file);

/** [BLOCK S6] a source file opens by saying what would make it change. */
function header(file, text, config) {
  const { include, extensions, text: marker } = config.header;
  if (!extensions.includes(path.extname(file)) || !matchesAny(file, include) || isTest(file)) return null;
  const top = text.split("\n").slice(0, 8).join("\n");
  return top.includes(marker)
    ? null
    : `[BLOCK S6] ${file} needs a first comment that starts with "${marker}" and names the one kind of decision that would make this file change.`;
}

/** [BLOCK TDD] logic has its test beside it. */
function test(root, file, text, config) {
  const { include, exempt } = config.tests;
  if (isTest(file) || file.endsWith(".d.ts") || !matchesAny(file, include)) return null;
  if (text.includes(exempt)) return null;
  const beside = file.replace(/\.ts$/, ".test.ts");
  return existsSync(path.join(root, beside))
    ? null
    : `[BLOCK TDD] ${file} has no test beside it. Write ${beside} first, or mark the file with "// ${exempt} <reason>" when there is nothing in it to test.`;
}

/** [BLOCK SIZE] the limits, as ESLint counts them. Silent when ESLint is not installed yet. */
function limits(root, files) {
  const eslint = path.join(root, "node_modules", ".bin", "eslint");
  if (files.length === 0 || !existsSync(eslint)) return [];
  let output;
  try {
    output = execFileSync(eslint, ["--format", "json", "--no-warn-ignored", ...files], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (error) {
    output = error.stdout;
  }
  const misses = [];
  for (const result of JSON.parse(output || "[]"))
    for (const message of result.messages)
      if (LIMIT_RULES.has(message.ruleId))
        misses.push(
          `[BLOCK SIZE] ${relative(root, result.filePath)}:${message.line} ${message.message} Split it by responsibility. The limit is not yours to raise.`,
        );
  return misses;
}

function check(root, files, config) {
  const misses = [];
  const linted = [];
  for (const file of files) {
    if (!/\.tsx?$/.test(file) || !file.startsWith("src/")) continue;
    let text;
    try {
      text = readFileSync(path.join(root, file), "utf8");
    } catch {
      continue;
    }
    for (const miss of [header(file, text, config), test(root, file, text, config)])
      if (miss) misses.push(miss);
    linted.push(file);
  }
  return [...misses, ...limits(root, linted)];
}

function everyFile(root, folder = "src") {
  const found = [];
  for (const entry of readdirSync(path.join(root, folder), { withFileTypes: true })) {
    const child = `${folder}/${entry.name}`;
    if (entry.isDirectory()) found.push(...everyFile(root, child));
    else found.push(child);
  }
  return found;
}

if (process.argv.includes("--all")) {
  const root = process.cwd();
  const misses = check(root, everyFile(root), rules(root));
  for (const miss of misses) console.error(miss);
  console.error(misses.length === 0 ? "The harness finds nothing." : `${misses.length} to fix.`);
  process.exit(misses.length === 0 ? 0 : 1);
}

try {
  const input = payload();
  const file = input?.tool_input?.file_path;
  if (typeof file !== "string") process.exit(0);
  const root = projectDir(input);
  const target = relative(root, file);
  if (!target) process.exit(0);
  const misses = check(root, [target], rules(root));
  if (misses.length > 0) {
    console.error(misses.join("\n"));
    process.exit(2);
  }
} catch {}
process.exit(0);
