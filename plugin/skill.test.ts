// The skill is a map of the packages and components. These keep the map from drifting off the territory.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "..");
const read = (file: string) => readFileSync(path.join(root, file), "utf8");
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

  it("gives the registry address the registry is served from", () => {
    expect(components).toContain(
      "https://raw.githubusercontent.com/Guidevit/cordwood/main/registry/r/{name}.json",
    );
  });
});
