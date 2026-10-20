// Run directories from before and after phase 4 are both served (docs/phase4.md, compatibility):
// a fake arena run as phase 4 writes it (`perfidia-arena/2`, `estimate.json`, `seats.json` with the
// lineup, budget and fallbacks fields, `preflight` lines in `llm_calls.jsonl`) and the same run
// rewritten as phase 3 wrote it (`perfidia-arena/1`, no phase-4 file, field or line). The side-file
// readers accept both; the server lists both, ended, with their LLM seats; the annotations of a
// turn are the same.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LlmLogLineSchema, SeatsFileSchema } from "@perfidia/protocol";
import { readArenaFile, readSeatsFile } from "./store/rundir.ts";
import {
  fakeRun,
  metaOf,
  rows,
  serve,
  stopServers,
  tempDir,
  testConfig,
  type TestServer,
} from "./testkit.test.ts";

const LONG = 120_000;
const PHASE4_LINES = new Set(["preflight", "prompt_cap", "kill_switch", "operator", "carry"]);

let root = "";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The JSON object in `path`, and its `seats` array of objects. */
function readObject(path: string): {
  file: Record<string, unknown>;
  seats: Record<string, unknown>[];
} {
  const file: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isRecord(file) || !Array.isArray(file.seats))
    throw new Error(`${path}: not an object with seats`);
  const list: unknown[] = file.seats;
  return { file, seats: list.filter(isRecord) };
}

/** `record` without `keys`. */
function without(
  record: Record<string, unknown>,
  keys: readonly string[],
): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([k]) => !keys.includes(k)));
}

/** `dir` rewritten as a phase-3 run directory. */
function downgrade(dir: string): void {
  const arenaPath = join(dir, "arena.json");
  const arena = readObject(arenaPath);
  writeFileSync(
    arenaPath,
    JSON.stringify(
      {
        ...without(arena.file, ["budget", "exit4"]),
        format: "perfidia-arena/1",
        seats: arena.seats.map((s) => without(s, ["promptCaps"])),
      },
      null,
      2,
    ),
  );
  const seatsPath = join(dir, "seats.json");
  const seats = readObject(seatsPath);
  writeFileSync(
    seatsPath,
    JSON.stringify({
      ...without(seats.file, ["lineup", "estimateSha256", "promptCapTokens", "budgetNanoUsd"]),
      seats: seats.seats.map((s) => without(s, ["fallbacks"])),
    }),
  );
  const callsPath = join(dir, "llm_calls.jsonl");
  const kept = rows(readFileSync(callsPath, "utf8")).filter((r) => {
    const line: unknown = JSON.parse(r);
    return isRecord(line) && typeof line.k === "string" && !PHASE4_LINES.has(line.k);
  });
  writeFileSync(callsPath, `${kept.join("\n")}\n`);
  rmSync(join(dir, "estimate.json"));
}

beforeAll(async () => {
  const run = await fakeRun({ days: 1, seed: 3 });
  root = tempDir("compat");
  cpSync(run.dir, join(root, "now"), { recursive: true });
  cpSync(run.dir, join(root, "phase3"), { recursive: true });
  downgrade(join(root, "phase3"));
}, LONG);

afterAll(stopServers);

describe("run directories from before and after phase 4", () => {
  test("the side-file readers accept both formats", () => {
    const now = readFileSync(join(root, "now", "llm_calls.jsonl"), "utf8");
    expect(rows(now).some((r) => r.includes('"k":"preflight"'))).toBe(true);
    for (const id of ["now", "phase3"]) {
      const dir = join(root, id);
      const arena = readArenaFile(dir);
      expect([id, arena.ok && arena.value.status, arena.ok && arena.value.fake]).toEqual([
        id,
        "ended",
        true,
      ]);
      const seats = readSeatsFile(dir);
      expect([id, seats.ok]).toEqual([id, true]);
      for (const r of rows(readFileSync(join(dir, "llm_calls.jsonl"), "utf8"))) {
        expect(LlmLogLineSchema.safeParse(JSON.parse(r)).success).toBe(true);
      }
    }
    expect(readObject(join(root, "phase3", "arena.json")).file.format).toBe("perfidia-arena/1");
    const file = SeatsFileSchema.parse(
      JSON.parse(readFileSync(join(root, "now", "seats.json"), "utf8")),
    );
    expect([file.promptCapTokens, typeof file.estimateSha256]).toEqual([160_000, "string"]);
  });

  test(
    "the server lists and serves both, ended, with the same LLM seats and annotations",
    async () => {
      const s: TestServer = serve(testConfig({ runs: root, adapter: "raw" }));
      const [now, old] = [
        await metaOf(s, "now", { settled: true }),
        await metaOf(s, "phase3", { settled: true }),
      ];
      expect([now.status, old.status]).toEqual(["ended", "ended"]);
      expect(old.seats).toEqual(now.seats);
      expect(
        now.seats.filter((x) => x.kind === "llm").map((x) => [x.seat, x.model?.model, x.fake]),
      ).toEqual([
        ["p1", "claude-opus-5-5", true],
        ["p2", "claude-opus-5-5", true],
        ["p3", "claude-opus-5-5", true],
        ["p4", "claude-opus-5-5", true],
      ]);
      const annotation = async (id: string) => {
        const res = await fetch(`${s.url}/api/matches/${id}/annotations/p1/1`);
        expect(res.status).toBe(200);
        return res.text();
      };
      expect(await annotation("phase3")).toBe(await annotation("now"));
    },
    LONG,
  );
});
