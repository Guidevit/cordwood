import { getApps } from "firebase-admin/app";
import { beforeAll, describe, expect, it } from "vitest";
import { adminApp, auth, firestore } from "./admin.js";
import { isDocumentId, tenantRef } from "./tenant.js";

// A project id is all a reference needs: nothing here opens a connection.
beforeAll(() => {
  process.env.GCLOUD_PROJECT = "demo-cordwood";
});

describe("the admin app", () => {
  it("is initialised once and reused", () => {
    expect(getApps()).toHaveLength(0);
    const first = adminApp();
    expect(adminApp()).toBe(first);
    expect(getApps()).toHaveLength(1);
  });

  it("is the app Firestore and Auth are read from", () => {
    expect(firestore()).toBe(firestore());
    expect(auth().app).toBe(adminApp());
    expect(getApps()).toHaveLength(1);
  });
});

describe("a document id", () => {
  it.each(["abc", "A-b_9", "f47ac10b-58cc-4372-a567-0e02b2c3d479", "a".repeat(128)])(
    "takes %s",
    (id) => expect(isDocumentId(id)).toBe(true),
  );

  it.each([
    ["an empty string", ""],
    ["a path into a subcollection", "a/b/c"],
    ["a parent path", ".."],
    ["a reserved id", "__name__"],
    ["129 characters", "a".repeat(129)],
    ["a space", "a b"],
    ["a non-string", 42],
    ["undefined", undefined],
  ])("refuses %s", (_case, id) => expect(isDocumentId(id)).toBe(false));
});

describe("a tenant's root", () => {
  it("is tenants/{tenantId}", () => {
    expect(tenantRef(firestore(), "acme").path).toBe("tenants/acme");
  });

  it.each(["", "a/b/c", "__x__"])("refuses the id %j", (id) => {
    expect(() => tenantRef(firestore(), id)).toThrow("invalid tenant id");
  });
});
