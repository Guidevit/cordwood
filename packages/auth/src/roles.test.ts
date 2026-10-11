import { describe, expect, it } from "vitest";
import { defineRoles } from "./roles.js";

const roles = defineRoles({
  owner: ["read", "write", "members.manage"],
  editor: ["read", "write"],
  viewer: ["read"],
});

describe("the app's roles", () => {
  it("keeps the order they were written in", () => {
    expect(roles.names).toEqual(["owner", "editor", "viewer"]);
  });

  it("says what each role may do", () => {
    expect(roles.can("owner", "members.manage")).toBe(true);
    expect(roles.can("editor", "write")).toBe(true);
    expect(roles.can("editor", "members.manage")).toBe(false);
    expect(roles.can("viewer", "write")).toBe(false);
  });

  it("lists who holds a permission", () => {
    expect(roles.holders("write")).toEqual(["owner", "editor"]);
    expect(roles.holders("read")).toEqual(["owner", "editor", "viewer"]);
  });

  it.each(["owner", "viewer"])("takes %s as a role", (value) => {
    expect(roles.isRole(value)).toBe(true);
  });

  it.each([
    ["another word", "admin"],
    ["a key every object has", "constructor"],
    ["an empty string", ""],
    ["a number", 1],
    ["undefined", undefined],
  ])("refuses %s as a role", (_case, value) => {
    expect(roles.isRole(value)).toBe(false);
  });

  it("needs at least one role", () => {
    expect(() => defineRoles({})).toThrow("at least one role");
  });
});
