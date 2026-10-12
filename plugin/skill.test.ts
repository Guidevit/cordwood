// The skill is a map of the packages and components. These keep the map from drifting off the territory.
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "..");
const read = (file: string) => readFileSync(path.join(root, file), "utf8");
/** Throws unless `target` is a file or a folder of the repository. */
const readdirOrFile = (target: string) => statSync(path.join(root, target));
const skill = read("plugin/skills/cordwood/SKILL.md");
const wiring = read("plugin/skills/cordwood/references/wiring.md");
const components = read("plugin/skills/cordwood/references/components.md");

const packages = readdirSync(path.join(root, "packages"));
const items = (JSON.parse(read("registry/registry.json")) as { items: { name: string }[] }).items;

/** Everything a package's source says, tests left out. */
const sourceOf = (name: string) =>
  readdirSync(path.join(root, "packages", name, "src"))
    .filter((file) => file.endsWith(".ts") && !file.includes(".test."))
    .map((file) => read(`packages/${name}/src/${file}`))
    .join("\n");

// The names the skill tells Claude to call, by the package that must still have them.
const NAMED: Record<string, string[]> = {
  firebase: ["firestore", "auth", "tenantRef", "isDocumentId", "--check"],
  auth: ["defineRoles", "createAuth", "managePermission", "exchange", "cookieName", "cookieOptions", "require", "admit", "changeRole", "remove", "continueUrl", "deliver"],
  email: ["createEmailSender", "subscriptionFrom", "failureStatus", "createEventReader", "subscription"],
  billing: ["createBilling", "STRIPE_CLIENT_OPTIONS", "checkout", "portal", "handleWebhook", "LiveSubscription", "PAYING_STATUSES", "successPath", "cancelPath", "returnPath"],
  analytics: ["defineEvents", "createAnalytics", "timeZone", "record", "engagement"],
  surveys: ["createSurveys", "triggers", "usingSince", "ask", "answer", "results"],
  changelog: ["createChangelog", "status", "markRead", "subscribe", "unsubscribe", "applyMailEvents", "SendStopped", "oneClickUrl", "unsubscribePath", "forget"],
  experiments: ["createExperiments", "defineExperiments", "createVisitors", "sampleSize", "perArm", "expose", "convert", "isRobot", "isPrefetch", "refusesTracking", "mismatch", "reached"],
  tour: ["createTours", "seen", "end", "useTour", "replayTour", "useCanReplay", "replay"],
};

describe("the cordwood skill", () => {
  it("has the frontmatter Claude Code reads", () => {
    const [, frontmatter] = /^---\n([\s\S]*?)\n---\n/.exec(skill) ?? [];
    expect(frontmatter).toMatch(/^name: cordwood$/m);
    const description = /^description: (.+)$/m.exec(frontmatter!)![1]!;
    expect(description.length).toBeGreaterThan(100);
    expect(description.length).toBeLessThanOrEqual(1024);
  });

  it.each(packages)("maps @cordwood/%s, and tells how to wire it", (name) => {
    expect(skill).toContain(`\`@cordwood/${name}\``);
    expect(wiring).toContain(`## @cordwood/${name}\n`);
    expect(Object.keys(NAMED)).toContain(name);
  });

  it.each(items.map((item) => item.name))("maps the component %s", (name) => {
    expect(skill).toContain(`\`${name}\``);
    expect(components).toContain(`\`${name}\``);
  });

  it.each(Object.entries(NAMED))("names only what @cordwood/%s still has", (name, identifiers) => {
    const source = sourceOf(name);
    const said = `${skill}\n${wiring}\n${components}`;
    for (const identifier of identifiers) {
      expect(said, `the skill no longer mentions ${identifier}`).toContain(identifier);
      expect(source, `${name} no longer has ${identifier}`).toContain(identifier);
    }
  });

  it("points at files that exist", () => {
    for (const [, target] of skill.matchAll(/\]\((references\/[^)]+)\)/g))
      expect(() => read(`plugin/skills/cordwood/${target}`)).not.toThrow();
  });

  it.each(["cordwood", "new-app", "improve"])("gives %s the frontmatter and the files it points at", (name) => {
    const text = read(`plugin/skills/${name}/SKILL.md`);
    const [, frontmatter] = /^---\n([\s\S]*?)\n---\n/.exec(text) ?? [];
    expect(frontmatter).toMatch(new RegExp(`^name: ${name}$`, "m"));
    expect(/^description: (.+)$/m.exec(frontmatter!)![1]!.length).toBeLessThanOrEqual(1024);
    for (const [, target] of text.matchAll(/\]\((references\/[^)#]+)/g))
      expect(() => read(`plugin/skills/${name}/${target}`)).not.toThrow();
  });

  it("builds the new app from every package and component, by names they still have", () => {
    const skillText = read("plugin/skills/new-app/SKILL.md");
    const base = read("plugin/skills/new-app/references/base-app.md");
    for (const name of packages) expect(skillText).toContain(`@cordwood/${name}`);
    for (const item of items) expect(skillText).toContain(`@cordwood/${item.name}`);
    const calls: [string, string[]][] = [
      ["auth", ["exchange", "read", "end", "admit", "changeRole", "remove", "list", "cookieName", "cookieOptions", "require", "invitedAt"]],
      ["changelog", ["forget", "send", "subscription"]],
      ["tour", ["forget", "seen"]],
      ["billing", ["subscription"]],
      ["firebase", ["isDocumentId"]],
      ["experiments", ["defineExperiments"]],
    ];
    for (const [name, identifiers] of calls)
      for (const identifier of identifiers) {
        expect(base, `the base no longer mentions ${identifier}`).toContain(identifier);
        expect(sourceOf(name), `${name} no longer has ${identifier}`).toContain(identifier);
      }
  });

  it("sends both building skills to the improve skill, which names the commands this repository has", () => {
    for (const name of ["cordwood", "new-app"])
      expect(read(`plugin/skills/${name}/SKILL.md`)).toContain("`improve` skill");
    const improve = read("plugin/skills/improve/SKILL.md");
    const scripts = (JSON.parse(read("package.json")) as { scripts: Record<string, string> }).scripts;
    for (const script of ["build", "typecheck", "test"]) {
      expect(improve).toContain(`pnpm ${script}`);
      expect(scripts).toHaveProperty(script);
    }
    expect(improve).toContain("https://github.com/Guidevit/cordwood");
    expect(() => read(".changeset/config.json")).not.toThrow();
  });

  it("carries one version in the plugin and in the marketplace", () => {
    const plugin = JSON.parse(read("plugin/.claude-plugin/plugin.json")) as { version: string };
    const market = JSON.parse(read(".claude-plugin/marketplace.json")) as {
      plugins: { version: string }[];
    };
    expect(market.plugins[0]!.version).toBe(plugin.version);
  });

  it("offers a prompt in the README that points at files this repository has", () => {
    const readme = read("README.md");
    const prompt = /```text\n([\s\S]*?)```/.exec(readme)![1]!;
    const paths = [...prompt.matchAll(/~\/\.cordwood\/repo\/(plugin\/[\w\/.-]*[\w])/g)].map((m) => m[1]!);
    expect(paths.length).toBeGreaterThanOrEqual(3);
    for (const target of paths) expect(() => readdirOrFile(target)).not.toThrow();
    expect(prompt).toContain("https://github.com/Guidevit/cordwood");
    expect(prompt).toContain("cordwood@cordwood");
    for (const step of ["## 6. Run it and walk it", "## 8. Now the business rules"])
      expect(read("plugin/skills/new-app/SKILL.md")).toContain(step);
  });

  it("gives the registry address the registry is served from", () => {
    expect(components).toContain(
      "https://raw.githubusercontent.com/Guidevit/cordwood/main/registry/r/{name}.json",
    );
  });
});
