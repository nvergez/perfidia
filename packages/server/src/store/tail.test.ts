import { afterAll, expect, test } from "bun:test";
import { closeSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openRegular } from "./tail.ts";

const dir = mkdtempSync(join(tmpdir(), "perfidia-server-tail-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("openRegular opens a regular file and refuses a link, a FIFO and a missing path", () => {
  const file = join(dir, "match.jsonl");
  writeFileSync(file, '{"k":"header"}\n');
  const opened = openRegular(file);
  expect(opened?.size).toBe(15);
  if (opened !== null) closeSync(opened.fd);

  const link = join(dir, "link.jsonl");
  symlinkSync(file, link);
  expect(openRegular(link)).toBeNull();

  const fifo = join(dir, "replies.jsonl");
  expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
  const started = performance.now();
  expect(openRegular(fifo)).toBeNull();
  expect(performance.now() - started).toBeLessThan(1000);

  expect(openRegular(join(dir, "missing.jsonl"))).toBeNull();
});
