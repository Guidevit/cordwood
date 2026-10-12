// The hooks the new-app skill installs in a project, run as Claude Code runs them: a payload on stdin,
// a decision on stdout or an exit code.
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

const harness = path.resolve(import.meta.dirname, "skills/new-app/harness");
const made: string[] = [];
let root = "";

/** A project with the harness installed the way the skill installs it, in a fresh git repository. */
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "cordwood-harness-"));
  made.push(root);
  mkdirSync(path.join(root, ".claude"));
  cpSync(path.join(harness, "hooks"), path.join(root, ".claude/hooks"), { recursive: true });
  cpSync(path.join(harness, "rules.json"), path.join(root, ".claude/rules.json"));
  write(".gitignore", ".env.local\n");
  git("init", "-q");
  git("add", "-A");
  git("-c", "user.email=a@example.com", "-c", "user.name=a", "commit", "-q", "-m", "start");
});
afterAll(() => {
  for (const folder of made) rmSync(folder, { recursive: true, force: true });
});

const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });

function write(file: string, text: string) {
  mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  writeFileSync(path.join(root, file), text);
}

function run(hook: string, input: object, env: Record<string, string> = {}) {
  const result = spawnSync("node", [path.join(root, ".claude/hooks", hook)], {
    input: JSON.stringify(input),
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: root, HARNESS_UNLOCKED: "", ...env },
  });
  const decision = result.stdout
    ? (JSON.parse(result.stdout).hookSpecificOutput as {
        permissionDecision: string;
        permissionDecisionReason: string;
      })
    : null;
  return { status: result.status, stderr: result.stderr, decision };
}

const bash = (command: string, extra: object = {}, env?: Record<string, string>) =>
  run("guard-bash.mjs", { tool_name: "Bash", tool_input: { command }, ...extra }, env);
const edit = (file: string, env?: Record<string, string>) =>
  run("guard-harness.mjs", { tool_name: "Edit", tool_input: { file_path: path.join(root, file) } }, env);
const wrote = (file: string) =>
  run("check-file.mjs", { tool_name: "Write", tool_input: { file_path: path.join(root, file) } });

// Built here so that no line of this repository looks like a key.
const key = (prefix: string) => prefix + "a1B2".repeat(8);

describe("a shell command", () => {
  it.each([
    "pnpm test",
    "git status",
    "rm -rf node_modules .next",
    "rm -rf /tmp/scratch-123",
    "rm -f notes.txt",
    "node .claude/hooks/check-file.mjs --all 2>&1",
    "cat .claude/rules.json",
    "firebase emulators:exec --project demo-app \"next dev\"",
    "gh repo create app --private --source . --push",
  ])("runs unasked: %s", (command) => {
    expect(bash(command)).toEqual({ status: 0, stderr: "", decision: null });
  });

  it.each([
    ["rm -rf src", "deletes src"],
    ["cd app && rm -fr ./data", "deletes ./data"],
    ["rm -rf node_modules ../other", "deletes ../other"],
    ["rm -rf /tmp/../etc", "deletes /tmp/../etc"],
    ["rm -r --force $HOME/x", "deletes $HOME/x"],
    ["git reset --hard HEAD~1", "uncommitted work"],
    ["git checkout -- .", "uncommitted work"],
    ["git restore .", "uncommitted work"],
    ["git branch -D feature", "unmerged work"],
    ["firebase deploy --only firestore:indexes", "real Firebase project"],
    ["firebase firestore:delete --all-collections", "real Firebase project"],
    ["firebase emulators:start --project my-app-prod", "real project my-app-prod"],
    ["gh repo create app --public --source .", "public repository"],
    ["pnpm publish --access public", "publishes a package"],
  ])("asks first: %s", (command, why) => {
    const { decision } = bash(command);
    expect(decision?.permissionDecision).toBe("ask");
    expect(decision?.permissionDecisionReason).toContain(why);
  });

  it("asks nobody who chose to run without prompts", () => {
    expect(bash("rm -rf src", { permission_mode: "bypassPermissions" }).decision).toBeNull();
  });

  it.each([
    "echo '{}' > .claude/rules.json",
    "sed -i '' 's/100/900/' .claude/rules.json",
    "rm .claude/hooks/check-file.mjs",
    "cp /tmp/x.mjs .claude/hooks/guard-bash.mjs",
    "cat a >> ./eslint.limits.mjs",
  ])("may not write the harness: %s", (command) => {
    expect(bash(command).decision?.permissionDecision).toBe("deny");
    expect(bash(command, {}, { HARNESS_UNLOCKED: "1" }).decision).toBeNull();
  });

  it("runs when the payload is unreadable, or names another tool", () => {
    const hook = path.join(root, ".claude/hooks/guard-bash.mjs");
    expect(spawnSync("node", [hook], { input: "not json", encoding: "utf8" }).status).toBe(0);
    expect(run("guard-bash.mjs", { tool_name: "Read", tool_input: {} }).decision).toBeNull();
  });
});

describe("a commit", () => {
  it("goes through with ordinary changes and the two env files a project commits", () => {
    write("src/a.ts", "export const a = 1;\n");
    write(".env.development", "APP_ORIGIN=http://localhost:3000\n");
    write(".env.example", "STRIPE_SECRET_KEY=\n");
    expect(bash("git add -A && git commit -m 'start'").decision).toBeNull();
  });

  it.each([
    ["a Stripe secret key", () => key("sk_live_")],
    ["a Stripe secret key", () => key("sk_test_")],
    ["a Stripe webhook secret", () => key("whsec_")],
    ["a SendGrid key", () => `SG.${"a".repeat(22)}.${"b".repeat(43)}`],
    ["a private key", () => "-----BEGIN PRIVATE KEY-----"],
    ["a GitHub token", () => key("ghp_")],
  ])("is refused when a new file holds %s", (name, secret) => {
    write("src/config.ts", `export const value = "${secret()}";\n`);
    const { decision } = bash("git add -A && git commit -m 'config'");
    expect(decision?.permissionDecision).toBe("deny");
    expect(decision?.permissionDecisionReason).toContain(name);
  });

  it("is refused when a tracked file gains a secret, staged or not", () => {
    write("src/config.ts", "export const value = 1;\n");
    git("add", "-A");
    git("-c", "user.email=a@example.com", "-c", "user.name=a", "commit", "-q", "-m", "config");
    write("src/config.ts", `export const value = "${key("sk_live_")}";\n`);
    expect(bash("git commit -am 'key'").decision?.permissionDecision).toBe("deny");
    git("add", "-A");
    expect(bash("git commit -m 'key'").decision?.permissionDecision).toBe("deny");
  });

  it.each([".env", ".env.production", "app/.env.staging"])("is refused when it carries %s", (file) => {
    write(file, "A=1\n");
    const { decision } = bash("git add -A && git commit -m 'env'");
    expect(decision?.permissionDecision).toBe("deny");
    expect(decision?.permissionDecisionReason).toContain(`${file} is an env file`);
  });

  it("is not held up by an env file git ignores", () => {
    write(".env.local", `STRIPE_SECRET_KEY=${key("sk_live_")}\n`);
    expect(bash("git add -A && git commit -m 'nothing'").decision).toBeNull();
  });
});

describe("the harness's own files", () => {
  it.each([".claude/rules.json", ".claude/hooks/check-file.mjs", "eslint.limits.mjs"])(
    "refuse an agent's edit: %s",
    (file) => {
      expect(edit(file).decision?.permissionDecision).toBe("deny");
      expect(edit(file, { HARNESS_UNLOCKED: "1" }).decision).toBeNull();
    },
  );

  it.each([".claude/settings.json", "src/server/a.ts", "CLAUDE.md", "../outside.ts"])(
    "leave the rest alone: %s",
    (file) => {
      expect(edit(file).decision).toBeNull();
    },
  );
});

describe("a file just written", () => {
  const HEADER = "// Reason to change: how an invoice is totalled.\n";

  it("passes with its header and its test beside it", () => {
    write("src/server/invoices.ts", `${HEADER}export const total = () => 0;\n`);
    write("src/server/invoices.test.ts", "// a test\n");
    expect(wrote("src/server/invoices.ts")).toMatchObject({ status: 0, stderr: "" });
    expect(wrote("src/server/invoices.test.ts").status).toBe(0);
  });

  it("is sent back without the header", () => {
    write("src/app/api/invoices/route.ts", "export async function GET() {}\n");
    const result = wrote("src/app/api/invoices/route.ts");
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("[BLOCK S6] src/app/api/invoices/route.ts");
  });

  it("finds the header after a directive", () => {
    write("src/app/page.tsx", `"use client";\n${HEADER}export default function Page() { return null; }\n`);
    expect(wrote("src/app/page.tsx").status).toBe(0);
  });

  it("is sent back when logic has no test beside it", () => {
    write("src/lib/dates.ts", `${HEADER}export const today = () => new Date();\n`);
    const result = wrote("src/lib/dates.ts");
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("[BLOCK TDD] src/lib/dates.ts");
    expect(result.stderr).toContain("src/lib/dates.test.ts");
  });

  it("takes a reasoned exemption in place of a test", () => {
    write(
      "src/lib/firebase-client.ts",
      `${HEADER}// @tdd-exempt: only builds the browser SDK's client.\nexport const app = 1;\n`,
    );
    expect(wrote("src/lib/firebase-client.ts").status).toBe(0);
  });

  it.each([
    ["a component, which needs neither", "src/components/tour-card.tsx"],
    ["a page, which needs no test", "src/app/(app)/members/page.tsx"],
    ["a file outside src", "scripts/seed.ts"],
    ["a file that is no source", "src/server/notes.md"],
  ])("lets through %s", (_case, file) => {
    write(file, file.includes("/app/") ? `${HEADER}export default 1;\n` : "export default 1;\n");
    expect(wrote(file).status).toBe(0);
  });

  it("checks the whole of src when asked, and counts what it found", () => {
    write("src/server/a.ts", `${HEADER}export const a = 1;\n`);
    write("src/server/a.test.ts", "// a test\n");
    const all = () =>
      spawnSync("node", [".claude/hooks/check-file.mjs", "--all"], { cwd: root, encoding: "utf8" });
    expect(all()).toMatchObject({ status: 0, stderr: "The harness finds nothing.\n" });
    write("src/server/b.ts", "export const b = 1;\n");
    const second = all();
    expect(second.status).toBe(1);
    expect(second.stderr).toContain("[BLOCK S6] src/server/b.ts");
    expect(second.stderr).toContain("[BLOCK TDD] src/server/b.ts");
    expect(second.stderr).toContain("2 to fix.");
  });
});

describe("what the harness ships", () => {
  const settings = JSON.parse(readFileSync(path.join(harness, "settings.json"), "utf8")) as {
    hooks: Record<string, { hooks: { command: string }[] }[]>;
  };

  it("wires only hooks that exist", () => {
    const commands = Object.values(settings.hooks).flatMap((groups) =>
      groups.flatMap((group) => group.hooks.map((hook) => hook.command)),
    );
    expect(commands).toHaveLength(3);
    for (const command of commands) {
      const [, file] = /\.claude\/hooks\/([\w-]+\.mjs)$/.exec(command)!;
      expect(() => readFileSync(path.join(harness, "hooks", file!))).not.toThrow();
    }
  });

  it("states in the CLAUDE.md section the limits rules.json sets", () => {
    const { limits } = JSON.parse(readFileSync(path.join(harness, "rules.json"), "utf8")) as {
      limits: Record<string, number>;
    };
    const section = readFileSync(path.join(harness, "CLAUDE.section.md"), "utf8");
    for (const [name, text] of [
      ["functionLines", "| 100 lines |"],
      ["componentLines", "| 500 lines |"],
      ["routeLines", "| 300 lines |"],
      ["params", "| 6 |"],
      ["complexity", "| 15 |"],
    ] as const) {
      expect(text).toContain(String(limits[name]));
      expect(section).toContain(text);
    }
  });
});
