// The test suites (docs/architecture.md §13.8): the default `bun test` skips the slow tests, which
// read PERFIDIA_SLOW; `bun run test:slow` runs every file that reads it with PERFIDIA_SLOW=1, and
// `bun run test:exit` (CI's exit job) runs `test:slow` after the exit suite. A slow test in a file
// that `test:slow` does not list would run nowhere, so the list must be exactly those files.

import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { z } from "@perfidia/protocol";

const ROOT = resolve(import.meta.dir, "../../..");
const SELF = relative(ROOT, import.meta.path);

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Every test file under `dir`, dependencies left out, as paths relative to the repository root. */
function testFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return e.name === "node_modules" ? [] : testFiles(path);
    return /\.test\.tsx?$/.test(e.name) ? [relative(ROOT, path)] : [];
  });
}

const PackageSchema = z.object({ scripts: z.record(z.string(), z.string()) });

test("test:slow lists exactly the test files that read PERFIDIA_SLOW; test:exit runs it", () => {
  const { scripts } = PackageSchema.parse(
    JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")),
  );
  const slow = scripts["test:slow"] ?? "";
  const prefix = "PERFIDIA_SLOW=1 bun test ";
  expect(slow.startsWith(prefix)).toBe(true);
  const listed = slow.slice(prefix.length).split(" ");
  const gated = testFiles(join(ROOT, "packages"))
    .filter((f) => f !== SELF && readFileSync(join(ROOT, f), "utf8").includes("PERFIDIA_SLOW"))
    .toSorted(byText);
  expect(gated.length).toBeGreaterThan(0);
  expect(listed).toEqual(gated);
  expect(scripts["test:exit"]?.endsWith(" && bun run test:slow")).toBe(true);
});
