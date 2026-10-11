import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectFragments, mergeIndexes, syncIndexes, type IndexFile } from "./indexes.js";

const index = (group: string, ...fields: string[]) => ({
  collectionGroup: group,
  queryScope: "COLLECTION",
  fields: fields.map((fieldPath) => ({ fieldPath, order: "ASCENDING" })),
});
const ttl = (group: string, fieldPath: string) => ({ collectionGroup: group, fieldPath, ttl: true });
const file = (indexes: object[] = [], fieldOverrides: object[] = []) =>
  ({ indexes, fieldOverrides }) as IndexFile;

describe("merging index fragments", () => {
  it("adds a fragment's indexes after the project's own", () => {
    const merged = mergeIndexes(file([index("orders", "status", "at")]), [
      { from: "@x/a", file: file([index("product_events", "type", "day")]) },
    ]);
    expect(merged.indexes).toEqual([
      index("orders", "status", "at"),
      index("product_events", "type", "day"),
    ]);
  });

  it("keeps one of an index two sides ask for, whatever the key order", () => {
    const reordered = {
      fields: [
        { order: "ASCENDING", fieldPath: "type" },
        { order: "ASCENDING", fieldPath: "day" },
      ],
      queryScope: "COLLECTION",
      collectionGroup: "product_events",
    };
    const merged = mergeIndexes(file([index("product_events", "type", "day")]), [
      { from: "@x/a", file: file([reordered]) },
      { from: "@x/b", file: file([index("product_events", "type", "day")]) },
    ]);
    expect(merged.indexes).toHaveLength(1);
  });

  it("tells apart indexes whose fields are in another order", () => {
    const merged = mergeIndexes(file([index("events", "type", "day")]), [
      { from: "@x/a", file: file([index("events", "day", "type")]) },
    ]);
    expect(merged.indexes).toHaveLength(2);
  });

  it("changes nothing when run on its own result", () => {
    const fragments = [{ from: "@x/a", file: file([index("a", "x")], [ttl("a", "expiresAt")]) }];
    const once = mergeIndexes(file([index("b", "y")]), fragments);
    expect(mergeIndexes(once, fragments)).toEqual(once);
  });

  it("keeps one of a field override two sides agree on", () => {
    const merged = mergeIndexes(file([], [ttl("visits", "expiresAt")]), [
      { from: "@x/a", file: file([], [ttl("visits", "expiresAt")]) },
    ]);
    expect(merged.fieldOverrides).toEqual([ttl("visits", "expiresAt")]);
  });

  it("refuses two different overrides of one field, naming both sides", () => {
    const other = { collectionGroup: "visits", fieldPath: "expiresAt", indexes: [] };
    expect(() =>
      mergeIndexes(file([], [ttl("visits", "expiresAt")]), [{ from: "@x/a", file: file([], [other]) }]),
    ).toThrow("@x/a and the project override the field visits/expiresAt differently");
    expect(() =>
      mergeIndexes(file(), [
        { from: "@x/a", file: file([], [ttl("visits", "expiresAt")]) },
        { from: "@x/b", file: file([], [other]) },
      ]),
    ).toThrow("@x/b and @x/a override");
  });
});

describe("a project's index file", () => {
  let dir = "";
  afterEach(() => rm(dir, { recursive: true, force: true }));

  async function project(deps: Record<string, { manifest: object; files?: Record<string, object> }>) {
    dir = await mkdtemp(path.join(tmpdir(), "cordwood-indexes-"));
    const names = Object.keys(deps);
    await writeFile(
      path.join(dir, "package.json"),
      JSON.stringify({
        dependencies: Object.fromEntries(names.slice(0, 1).map((n) => [n, "1.0.0"])),
        devDependencies: Object.fromEntries(names.slice(1).map((n) => [n, "1.0.0"])),
      }),
    );
    for (const [name, { manifest, files }] of Object.entries(deps)) {
      const at = path.join(dir, "node_modules", name);
      await mkdir(at, { recursive: true });
      await writeFile(path.join(at, "package.json"), JSON.stringify({ name, ...manifest }));
      for (const [relative, content] of Object.entries(files ?? {}))
        await writeFile(path.join(at, relative), JSON.stringify(content));
    }
    return dir;
  }
  const withFragment = (indexes: object[]) => ({
    manifest: { cordwood: { firestoreIndexes: "./firestore.indexes.json" } },
    files: { "firestore.indexes.json": file(indexes) },
  });
  const read = async () => JSON.parse(await readFile(path.join(dir, "firestore.indexes.json"), "utf8"));

  it("collects the fragments of dependencies and devDependencies, by name", async () => {
    await project({
      "@x/zeta": withFragment([index("z", "a")]),
      "@x/alpha": withFragment([index("a", "a")]),
      "plain-package": { manifest: {} },
    });
    expect((await collectFragments(dir)).map((f) => f.from)).toEqual(["@x/alpha", "@x/zeta"]);
  });

  it("is written when missing, and left alone when already right", async () => {
    await project({ "@x/a": withFragment([index("product_events", "type", "day")]) });
    expect(await syncIndexes({ projectDir: dir })).toMatchObject({ changed: true, from: ["@x/a"] });
    expect(await read()).toEqual(file([index("product_events", "type", "day")]));
    expect(await syncIndexes({ projectDir: dir })).toMatchObject({ changed: false });
  });

  it("keeps the project's own indexes and any other key of the file", async () => {
    await project({ "@x/a": withFragment([index("product_events", "type", "day")]) });
    await writeFile(
      path.join(dir, "firestore.indexes.json"),
      JSON.stringify({ $schema: "x", indexes: [index("orders", "status")], fieldOverrides: [] }),
    );
    await syncIndexes({ projectDir: dir });
    expect(await read()).toEqual({
      $schema: "x",
      indexes: [index("orders", "status"), index("product_events", "type", "day")],
      fieldOverrides: [],
    });
  });

  it("writes nothing under check, and says the file is out of date", async () => {
    await project({ "@x/a": withFragment([index("product_events", "type", "day")]) });
    expect(await syncIndexes({ projectDir: dir, check: true })).toMatchObject({ changed: true });
    await expect(read()).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses a fragment that points outside its package", async () => {
    await project({
      "@x/a": { manifest: { cordwood: { firestoreIndexes: "../../../package.json" } } },
    });
    await expect(collectFragments(dir)).rejects.toThrow("outside the package");
  });

  it("says which package names a fragment it does not ship", async () => {
    await project({ "@x/a": { manifest: { cordwood: { firestoreIndexes: "./missing.json" } } } });
    await expect(collectFragments(dir)).rejects.toThrow("@x/a: ./missing.json is missing");
  });
});
