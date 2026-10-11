#!/usr/bin/env node
// cordwood-firebase indexes [--check] [--file <path>]
import { syncIndexes } from "./indexes.js";

const USAGE = `cordwood-firebase indexes [--check] [--file <path>]

Merges the Firestore indexes your installed packages need into firestore.indexes.json.
  --check        write nothing, and exit 1 when the file is out of date
  --file <path>  the index file, relative to the current directory`;

async function main(args: string[]): Promise<number> {
  if (args[0] !== "indexes" || args.includes("--help")) {
    console.log(USAGE);
    return args.includes("--help") ? 0 : 2;
  }
  const at = args.indexOf("--file");
  const file = at >= 0 ? args[at + 1] : undefined;
  if (at >= 0 && !file) {
    console.error("--file needs a path");
    return 2;
  }
  const check = args.includes("--check");
  const result = await syncIndexes({ projectDir: process.cwd(), file, check });
  const sources = result.from.length ? result.from.join(", ") : "no package";
  if (!result.changed) {
    console.log(`${result.file} is up to date (${sources}).`);
    return 0;
  }
  if (check) {
    console.error(`${result.file} is out of date: run cordwood-firebase indexes (${sources}).`);
    return 1;
  }
  console.log(`${result.file} updated from ${sources}. Deploy it with firebase deploy --only firestore:indexes.`);
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  },
);
