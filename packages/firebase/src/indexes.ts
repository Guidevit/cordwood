// Firestore keeps every index of a project in one file. A package that queries ships the indexes it
// needs as a fragment, and this merges the fragments of a project's dependencies into that one file.
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

type Json = Record<string, unknown>;

export type IndexFile = {
  indexes: Json[];
  fieldOverrides: Json[];
};

/** A fragment and the package it came from, for the error that names a conflict. */
export type Fragment = { from: string; file: IndexFile };

/** A value with its object keys sorted, so two indexes written in different key order compare equal. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Json)[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

const overrideTarget = (override: Json) =>
  `${String(override.collectionGroup)}/${String(override.fieldPath)}`;

function asIndexFile(value: unknown, from: string): IndexFile {
  const file = (value ?? {}) as { indexes?: unknown; fieldOverrides?: unknown };
  const list = (name: "indexes" | "fieldOverrides") => {
    const found = file[name] ?? [];
    if (!Array.isArray(found)) throw new Error(`${from}: ${name} is not a list`);
    return found as Json[];
  };
  return { indexes: list("indexes"), fieldOverrides: list("fieldOverrides") };
}

/**
 * The project's own indexes plus every fragment's, each index once. What the project already has stays
 * first and in its order, so merging twice changes nothing.
 *
 * Two different overrides of the same field cannot both hold, so that throws and names both sides.
 */
export function mergeIndexes(base: IndexFile, fragments: readonly Fragment[]): IndexFile {
  const indexes = [...base.indexes];
  const seen = new Set(indexes.map(canonical));
  const fieldOverrides = [...base.fieldOverrides];
  const overrides = new Map(
    fieldOverrides.map((o) => [overrideTarget(o), { from: "the project", text: canonical(o) }]),
  );
  for (const { from, file } of fragments) {
    for (const index of file.indexes) {
      const text = canonical(index);
      if (seen.has(text)) continue;
      seen.add(text);
      indexes.push(index);
    }
    for (const override of file.fieldOverrides) {
      const target = overrideTarget(override);
      const held = overrides.get(target);
      const text = canonical(override);
      if (held && held.text !== text)
        throw new Error(
          `${from} and ${held.from} override the field ${target} differently: keep one in the project's file`,
        );
      if (held) continue;
      overrides.set(target, { from, text });
      fieldOverrides.push(override);
    }
  }
  return { indexes, fieldOverrides };
}

async function readJson(file: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return undefined;
    throw error;
  }
}

/**
 * The fragments of the project's direct dependencies: each installed package whose `package.json`
 * names one under `cordwood.firestoreIndexes`. Sorted by package name, so the merged file is the same
 * on every machine.
 */
export async function collectFragments(projectDir: string): Promise<Fragment[]> {
  const manifest = (await readJson(path.join(projectDir, "package.json"))) as
    | { dependencies?: Json; devDependencies?: Json }
    | undefined;
  if (!manifest) throw new Error(`no package.json in ${projectDir}`);
  const names = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies }).sort();
  const fragments: Fragment[] = [];
  for (const name of names) {
    const dir = path.join(projectDir, "node_modules", name);
    const dependency = (await readJson(path.join(dir, "package.json"))) as
      | { cordwood?: { firestoreIndexes?: unknown } }
      | undefined;
    const relative = dependency?.cordwood?.firestoreIndexes;
    if (typeof relative !== "string") continue;
    const file = path.resolve(dir, relative);
    // A fragment stays inside its own package.
    if (!file.startsWith(dir + path.sep)) throw new Error(`${name}: its fragment is outside the package`);
    const found = await readJson(file);
    if (found === undefined) throw new Error(`${name}: ${relative} is missing`);
    fragments.push({ from: name, file: asIndexFile(found, name) });
  }
  return fragments;
}

export type SyncResult = {
  /** Whether the file differs from what the dependencies ask for. */
  changed: boolean;
  /** The packages whose fragments were merged. */
  from: string[];
  file: string;
};

/**
 * Brings the project's index file up to what its dependencies need. With `check`, nothing is written:
 * the answer only says whether it would change, which is what a CI step asks.
 */
export async function syncIndexes(options: {
  projectDir: string;
  file?: string;
  check?: boolean;
}): Promise<SyncResult> {
  const file = path.resolve(options.projectDir, options.file ?? "firestore.indexes.json");
  const before = await readJson(file);
  const base = asIndexFile(before, path.basename(file));
  const fragments = await collectFragments(options.projectDir);
  const merged = mergeIndexes(base, fragments);
  const changed = before === undefined || canonical(before) !== canonical({ ...(before as Json), ...merged });
  if (changed && !options.check)
    await writeFile(file, `${JSON.stringify({ ...(before as Json | undefined), ...merged }, null, 2)}\n`);
  return { changed, from: fragments.map((f) => f.from), file };
}
