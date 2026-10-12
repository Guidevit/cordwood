import { describe, expect, it } from "vitest";
import { classifyFailure, oneClickUrl, unsubscribeUrl } from "./send.js";
import { alreadyHad, isExitCode, newExitCode } from "./state.js";

describe("whether a person already had a version", () => {
  it.each([
    ["the same version", "2.3.0", "2.3.0", true],
    ["a later one", "2.10.0", "2.9.0", true],
    ["a later one with fewer parts", "3", "2.9.9", true],
    ["an earlier one", "2.9.0", "2.10.0", false],
    ["an earlier one with fewer parts", "2.3", "2.3.1", false],
    ["the same with a trailing zero", "2.3", "2.3.0", true],
  ])("%s", (_case, had, version, expected) => {
    expect(alreadyHad(had, version)).toBe(expected);
  });

  it("compares versions that are not dotted numbers for equality only", () => {
    expect(alreadyHad("2026-10-11", "2026-10-11")).toBe(true);
    expect(alreadyHad("2026-10-12", "2026-10-11")).toBe(false);
    expect(alreadyHad("spring", "2.0.0")).toBe(false);
  });

  it.each([undefined, null, 3, {}])("has had nothing when the mark is %j", (had) => {
    expect(alreadyHad(had, "1.0.0")).toBe(false);
  });
});

describe("an exit code", () => {
  it("is 43 characters that also make a document id", () => {
    const code = newExitCode();
    expect(code).toHaveLength(43);
    expect(isExitCode(code)).toBe(true);
    expect(newExitCode()).not.toBe(code);
  });

  it.each([
    ["shorter", "abc"],
    ["a path", `${"a".repeat(20)}/${"b".repeat(22)}`],
    ["a reserved id", `__${"a".repeat(39)}__`],
    ["not a string", 43],
    ["undefined", undefined],
  ])("is refused when %s", (_case, code) => {
    expect(isExitCode(code)).toBe(false);
  });
});

describe("the links a message carries", () => {
  const code = "c".repeat(43);

  it("keeps the code after # on the page's link, where no server log sees it", () => {
    const url = new URL(unsubscribeUrl("https://app.example.com", "/changelog/unsubscribe", code));
    expect(url.origin + url.pathname).toBe("https://app.example.com/changelog/unsubscribe");
    expect(url.search).toBe("");
    expect(url.hash).toBe(`#token=${code}`);
  });

  it("puts the code in the query of the one-click address", () => {
    expect(oneClickUrl("https://app.example.com", "/api/changelog/unsubscribe", code)).toBe(
      `https://app.example.com/api/changelog/unsubscribe?t=${code}`,
    );
  });
});

describe("what a failed delivery means", () => {
  it.each([
    ["no answer came", { status: null }, "unknown"],
    ["the key was refused", { status: 401 }, "sender"],
    ["the sender may not send", { status: 403 }, "sender"],
    ["the rate was hit", { status: 429 }, "sender"],
    ["the service failed", { status: 503 }, "sender"],
    ["this message was refused", { status: 400 }, "message"],
    ["nothing was handed over", new Error("no key"), "sender"],
    ["something that is no error", null, "sender"],
  ])("%s", (_case, error, expected) => {
    expect(classifyFailure(error)).toBe(expected);
  });
});
