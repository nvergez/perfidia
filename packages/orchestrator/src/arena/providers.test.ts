// Phase 4, Pass 1b (docs/phase4.md): provider plumbing, end to end, with no network.
// - `arena estimate --cards`: the design's §5.4 table, generated from the cards and pinned.
// - `arena run --fake --lineup mid-tier --days 2 --price-date 2026-10-19`: Level E, the four intended
//   providers with their channel variants and cadence in `seats.json`, every attempt priced at its
//   intended card (the OpenRouter fee apart), the budget held, two runs byte-identical.
// - The presets plan; the seat grammar of the other providers; the plan's §4.2 refusals (endpoint
//   slugs, ZDR, ids holding ":", efforts, `--price-date` on a real run, keys per provider).
// The 2-day mid-tier runs and the effortSent run run in the slow suite (PERFIDIA_SLOW=1,
// docs/architecture.md §13.8: `bun run test:slow`, run by `bun run test:exit`).

import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { verifyLog } from "@perfidia/engine";
import { memoryIo, readLog } from "@perfidia/sim";
import { ArenaReportSchema, SeatsFileSchema, type LlmLogLine } from "../log/schema.ts";
import { costOf } from "../model/prices.ts";
import { main as arenaMain } from "./cli.ts";
import { arenaEnv, planArena, type ArenaRequest } from "./plan.ts";
import { readCalls, runDir } from "./rig.test.ts";

const SLOW = process.env["PERFIDIA_SLOW"] === "1";
/** A test of the slow suite: skipped unless PERFIDIA_SLOW=1. */
const xtest = test.skipIf(!SLOW);

/** `arena` as the CLI runs it, with no calibration profile unless a test passes `--profiles`. */
const main = (...[argv, io, env, o]: Parameters<typeof arenaMain>) =>
  arenaMain(argv, io, env, { profilesDir: "off", ...o });

const LONG = 120_000;
const MID = ["--fake", "--lineup", "mid-tier", "--seed", "1", "--id-key", "seed"];

async function cli(argv: readonly string[], env: Record<string, string> = {}) {
  const io = memoryIo();
  const code = await main(argv, io, env);
  return { code, out: io.stdout(), err: io.stderr() };
}

const byName = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function tree(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string): void => {
    for (const name of readdirSync(d).toSorted(byName)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out.set(relative(dir, p), readFileSync(p, "utf8"));
    }
  };
  walk(dir);
  return out;
}

/** The plan's refusal of `req` ("planned" when it plans). */
function planError(req: ArenaRequest, env: Record<string, string> = {}): string {
  try {
    planArena(req, arenaEnv(env));
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  return "planned";
}

/** The refusal of one seat spec, on the fake path unless `fake` is false. */
const refused = (seat: string, env: Record<string, string> = {}, fake = true): string =>
  planError({ fake, seed: 1, idKey: "seed", seats: [seat] }, env);

describe("arena estimate --cards (design §5.4)", () => {
  test("the table, generated from the cards: the design's rows but Sonnet 5.5's cache reads", async () => {
    const r = await cli(["estimate", "--cards"]);
    expect(r.code).toBe(0);
    const rows = r.out
      .split("\n")
      .filter((l) => /^(anthropic|openai|google|openrouter):/.test(l))
      .map((l) => {
        const f = l.trim().split(/\s{2,}/);
        return f.length === 5 ? [f[0], f[1], f[2], "", f[3], f[4]] : f;
      });
    // card, window, in / out / read / write ($/MTok), fee, 1-day central, 7-day low / central / high
    expect(rows).toEqual([
      [
        "anthropic:claude-fable-5-1@2026-10-20",
        "2026-10-19 on",
        "10 / 50 / 0.25 / 12.5",
        "",
        "$7.24",
        "$14.39 / $50.71 / $188.13",
      ],
      [
        "anthropic:claude-opus-5-5@2026-10-20",
        "2026-10-19 on",
        "4 / 20 / 0.2 / 5",
        "",
        "$2.97",
        "$5.98 / $20.82 / $76.65",
      ],
      // The design read $0.20 cache hits; the page checked on 2026-10-20 says $0.10.
      [
        "anthropic:claude-sonnet-5-5@2026-10-20",
        "2026-10-19 on",
        "2 / 10 / 0.1 / 2.5",
        "",
        "$1.49",
        "$2.99 / $10.41 / $38.33",
      ],
      [
        "anthropic:claude-haiku-5-5@2026-10-20",
        "2026-10-19 on",
        "0.1 / 0.5 / 0.01 / 0.125",
        "",
        "$0.08",
        "$0.16 / $0.55 / $1.99",
      ],
      [
        "openai:gpt-6.1-sol@2026-10-20",
        "2026-10-19 on",
        "2 / 10 / 0.1 / 2.5",
        "",
        "$1.49",
        "$2.99 / $10.41 / $38.33",
      ],
      [
        "openai:gpt-6-sol@2026-10-20",
        "2026-10-19 on",
        "2 / 10 / 0.2 / 2.5",
        "",
        "$1.56",
        "$3.21 / $10.95 / $39.73",
      ],
      [
        "openai:gpt-6-luna@2026-10-20",
        "2026-10-19 on",
        "0.1 / 0.5 / 0.01 / 0.125",
        "",
        "$0.08",
        "$0.16 / $0.55 / $1.99",
      ],
      [
        "openai:gpt-6-astra@2026-10-20",
        "2026-10-19 on",
        "10 / 50 / 1 / 12.5",
        "",
        "$7.82",
        "$16.06 / $54.75 / $198.63",
      ],
      [
        "google:gemini-4-argon@2026-10-20",
        "2026-10-19 to 2026-11-30",
        "2 / 10 / 0.1 / –",
        "",
        "$1.83",
        "$2.78 / $12.81 / $62.58",
      ],
      [
        "google:gemini-4-argon@2026-10-20#from2026-11-30",
        "2026-11-30 on",
        "4 / 20 / 0.2 / –",
        "",
        "$3.66",
        "$5.57 / $25.61 / $125.16",
      ],
      [
        "google:gemini-3.8-flash@2026-10-20",
        "2026-10-19 to 2026-12-31",
        "0.75 / 3.75 / 0.075 / –",
        "",
        "$0.71",
        "$1.13 / $4.94 / $23.47",
      ],
      [
        "google:gemini-3.8-flash@2026-10-20#from2026-12-31",
        "2026-12-31 on",
        "1.5 / 7.5 / 0.15 / –",
        "",
        "$1.41",
        "$2.25 / $9.89 / $46.94",
      ],
      [
        "openrouter:z-ai/glm-5.3(z-ai/fp8)@2026-10-20",
        "2026-10-19 on",
        "1.4 / 4.4 / 0.26 / –",
        "5.5%",
        "$1.14",
        "$1.92 / $7.99 / $37.25",
      ],
      [
        "openrouter:z-ai/glm-5.3-flash(z-ai/fp8)@2026-10-20",
        "2026-10-19 on",
        "0.15 / 0.5 / 0.03 / –",
        "5.5%",
        "$0.13",
        "$0.22 / $0.88 / $4.06",
      ],
      [
        "openrouter:moonshotai/kimi-k3(moonshotai/mxfp4)@2026-10-20",
        "2026-10-19 on",
        "3 / 15 / 0.3 / –",
        "5.5%",
        "$2.82",
        "$4.51 / $19.77 / $93.87",
      ],
      [
        "openrouter:deepseek/deepseek-v4.1-flash-1017(together)@2026-10-20",
        "2026-10-19 on",
        "0.3 / 1.2 / 0.006 / –",
        "5.5%",
        "$0.24",
        "$0.35 / $1.69 / $8.63",
      ],
    ]);
    expect(r.out).toContain(
      "implicit caches hit 100% low, 70% central, 0% high; platform fees apart",
    );
  });
});

describe("arena run --fake --lineup mid-tier (phase 4 Pass 1b)", () => {
  xtest(
    "2 days at the 2026-10-19 cards: Level E, four intended providers, their cards, the budget, byte-identical runs",
    async () => {
      const dirs = [runDir("a"), runDir("b")];
      for (const dir of dirs) {
        // oxlint-disable-next-line no-await-in-loop -- two identical runs
        const r = await cli([
          "run",
          ...MID,
          "--quiet",
          "--days",
          "2",
          "--price-date",
          "2026-10-19",
          "--out",
          dir,
        ]);
        expect(r.code).toBe(0);
        // Only the plan's alert on the GLM seat (stderr, even under --quiet); its effort is the
        // listed `low` the preset names, so no effort alert (review).
        expect(
          r.err
            .split("\n")
            .filter((l) => l !== "")
            .map((l) => l.slice(0, 34)),
        ).toEqual(["ALERT: p4: z-ai/glm-5.3@z-ai/fp8 d"]);
      }
      const [a, b] = dirs.map(tree);
      expect([...(a?.keys() ?? [])]).toEqual([...(b?.keys() ?? [])]);
      for (const [name, text] of a ?? []) {
        if (name !== "summary.json") expect([name, b?.get(name)]).toEqual([name, text]);
      }
      const dir = dirs[0] ?? "";
      const report = ArenaReportSchema.parse(
        JSON.parse(readFileSync(join(dir, "arena.json"), "utf8")),
      );
      expect([report.status, report.levelE?.ok]).toEqual(["ended", true]);
      expect(verifyLog(readLog(join(dir, "match.jsonl"))).ok).toBe(true);
      const seats = SeatsFileSchema.parse(
        JSON.parse(readFileSync(join(dir, "seats.json"), "utf8")),
      );
      expect([seats.lineup, seats.priceDate, seats.budgetNanoUsd]).toEqual([
        "mid-tier",
        "2026-10-19",
        200_000_000_000,
      ]);
      const llm = seats.seats.flatMap((s) => (s.kind === "llm" ? [s] : []));
      expect(
        llm.map((s) => [
          s.seat,
          s.label,
          s.intended?.provider,
          s.intended?.model,
          s.intended?.endpoint,
          s.promptVariant,
          s.reminders,
        ]),
      ).toEqual([
        [
          "p1",
          "llm:fake/claude-sonnet-5-5/medium:odysseus@1:p3",
          "anthropic",
          "claude-sonnet-5-5",
          null,
          "system",
          "last-round",
        ],
        [
          "p2",
          "llm:fake/gpt-6.1-sol/medium:achilles@1:p3-dev",
          "openai",
          "gpt-6.1-sol",
          null,
          "developer",
          "last-round",
        ],
        [
          "p3",
          "llm:fake/gemini-4-argon/medium:penelope@1:p3-env",
          "google",
          "gemini-4-argon",
          null,
          "envelope",
          "last-round",
        ],
        [
          "p4",
          "llm:fake/z-ai%2Fglm-5.3@z-ai%2Ffp8/low:agamemnon@1:p3-env",
          "openrouter",
          "z-ai/glm-5.3",
          "z-ai/fp8",
          "envelope",
          "last-round",
        ],
      ]);
      expect(
        llm.map((s) => [s.endpoint ?? null, s.quantization ?? null, s.reasoningContext ?? null]),
      ).toEqual([
        [null, null, null],
        [null, null, "all_turns"],
        [null, null, null],
        ["z-ai/fp8", "fp8", null],
      ]);
      // The header's controllers are the same labels.
      const header = readLog(join(dir, "match.jsonl"))[0];
      expect(header?.k === "header" ? llm.map((s) => header.controllers[s.seat]) : null).toEqual(
        llm.map((s) => s.label),
      );

      // Every attempt is priced at its seat's intended card on the pinned date, the fee apart.
      const intended = new Map(llm.map((s) => [s.seat, s.intended]));
      const calls = readCalls(dir);
      const attempts = calls.flatMap((l) => (l.k === "llm_call" ? [l] : []));
      const cardsBySeat = new Map<string, Set<string>>();
      let fees = 0;
      for (const l of attempts) {
        const want = intended.get(l.seat);
        if (want === undefined || want === null) throw new Error(`${l.seat}: no intended model`);
        const cost = costOf(
          l.usage.map((u) => ({
            model: u.model,
            kind: u.kind,
            estimated: u.estimated,
            tokens: {
              input: u.input,
              cacheWrite5m: u.cacheWrite5m,
              cacheWrite1h: u.cacheWrite1h,
              cacheRead: u.cacheRead,
              output: u.output,
            },
          })),
          { provider: want.provider, endpoint: want.endpoint, at: "2026-10-19T00:00:00Z" },
        );
        expect([l.seat, l.costNanoUsd, l.feeNanoUsd ?? 0, l.priceCard]).toEqual([
          l.seat,
          cost.nanoUsd,
          cost.feeNanoUsd,
          cost.cards[0],
        ]);
        expect(cost.unpriced).toEqual([]);
        fees += l.feeNanoUsd ?? 0;
        const set = cardsBySeat.get(l.seat) ?? new Set<string>();
        set.add(l.priceCard ?? "");
        cardsBySeat.set(l.seat, set);
      }
      expect([...cardsBySeat].map(([seat, set]) => [seat, [...set]])).toEqual([
        ["p1", ["anthropic:claude-sonnet-5-5@2026-10-20"]],
        ["p2", ["openai:gpt-6.1-sol@2026-10-20"]],
        ["p3", ["google:gemini-4-argon@2026-10-20"]],
        ["p4", ["openrouter:z-ai/glm-5.3(z-ai/fp8)@2026-10-20"]],
      ]);
      expect(fees).toBeGreaterThan(0);
      expect(attempts.filter((l) => l.seat !== "p4").every((l) => l.feeNanoUsd === undefined)).toBe(
        true,
      );
      // Reasoning kinds of the intended models: summaries, but GLM's raw reasoning.
      expect(
        [...new Set(attempts.map((l) => `${l.seat}:${l.reasoningKind ?? "?"}`))].toSorted(byName),
      ).toEqual(["p1:summary", "p2:summary", "p3:summary", "p4:raw"]);
      // The report: every figure a sum of logged lines, the fees apart, the budget held.
      const logged = calls.reduce(
        (n, l: LlmLogLine) => n + (l.k === "llm_call" || l.k === "preflight" ? l.costNanoUsd : 0),
        0,
      );
      expect(report.budget.actualNanoUsd).toBe(logged);
      expect(report.budget.feesNanoUsd).toBe(fees);
      expect(report.budget.under).toBe(true);
      expect(report.budget.killSwitch).toBeNull();
      expect(report.exit4?.models).toBe(4);
    },
    LONG,
  );
});

describe("effortSent on a fake run (review)", () => {
  xtest(
    "a fake OpenRouter seat at an effort its model does not list records the level sent",
    async () => {
      const dir = runDir("effort-sent");
      const r = await cli([
        "run",
        "--fake",
        "--seed",
        "1",
        "--id-key",
        "seed",
        "--days",
        "1",
        "--price-date",
        "2026-10-20",
        "--seat",
        "p1=openrouter:z-ai/glm-5.3@z-ai/fp8:medium:odysseus",
        "--quiet",
        "--out",
        dir,
      ]);
      expect(r.code).toBe(0);
      const seats = SeatsFileSchema.parse(
        JSON.parse(readFileSync(join(dir, "seats.json"), "utf8")),
      );
      const effort = seats.seats.flatMap((s) =>
        s.kind === "llm" ? [[s.seat, s.effort, s.effortSent ?? null]] : [],
      );
      expect(effort).toEqual([
        ["p1", "medium", "low"],
        ["p2", "medium", null],
        ["p3", "medium", null],
        ["p4", "medium", null],
      ]);
    },
    LONG,
  );
});

describe("the presets and the seat grammar (phase 4 Pass 1b)", () => {
  test("the four new presets plan on the fake path with their budgets above the predicted high", () => {
    for (const [id, usd] of [
      ["budget-mix", 40],
      ["mid-tier", 200],
      ["mid-tier-flash", 150],
      ["frontier", 570],
    ] as const) {
      const plan = planArena(
        { fake: true, lineup: id, seed: 1, idKey: "seed", priceDate: "2026-10-19" },
        arenaEnv({}),
      );
      expect([id, plan.budget?.budgetNanoUsd]).toEqual([id, usd * 1_000_000_000]);
      expect(plan.seats.filter((s) => s.kind === "llm").length).toBe(4);
    }
  });

  test("<provider>:<model>[@<endpoint>]:<effort>:<profile> plans every provider on the fake path", () => {
    const plan = planArena(
      {
        fake: true,
        seed: 1,
        idKey: "seed",
        priceDate: "2026-10-19",
        seats: [
          "p1=claude:haiku-5-5:low:odysseus",
          "p2=openai:gpt-6-luna:none:achilles",
          "p3=google:gemini-3.8-flash:high:penelope",
          "p4=openrouter:deepseek/deepseek-v4.1-flash-1017@together:high:agamemnon",
        ],
      },
      arenaEnv({}),
    );
    expect(
      plan.seats.flatMap((s) =>
        s.kind === "llm"
          ? [[s.seat, s.provider, s.model, s.endpoint, s.effort, s.promptVariant]]
          : [],
      ),
    ).toEqual([
      ["p1", "anthropic", "claude-haiku-5-5", null, "low", "system"],
      ["p2", "openai", "gpt-6-luna", null, "none", "developer"],
      ["p3", "google", "gemini-3.8-flash", null, "high", "envelope"],
      ["p4", "openrouter", "deepseek/deepseek-v4.1-flash-1017", "together", "high", "envelope"],
    ]);
  });

  test("the plan's refusals name the seat and the fix (design §2.5, §4.2)", () => {
    expect(refused("p1=openrouter:z-ai/glm-5.3:medium:odysseus")).toContain(
      'p1: openrouter seats need a full endpoint slug (e.g. "z-ai/fp8")',
    );
    expect(refused("p1=openrouter:z-ai/glm-5.3@z-ai/bf16:medium:odysseus")).toContain(
      "p1: z-ai/bf16 is not an endpoint of z-ai/glm-5.3 on OpenRouter",
    );
    expect(refused("p1=openai:gpt-6-luna@x:medium:odysseus")).toContain(
      "gpt-6-luna@x is not a seat model; a seat runs on gpt-6.1-sol, gpt-6-sol, gpt-6-luna, gpt-6-astra",
    );
    // An OpenRouter `:free` id cannot be written: ":" separates the seat grammar's fields.
    expect(
      refused("p1=openrouter:deepseek/deepseek-v4.1-flash:free@together:medium:odysseus"),
    ).toContain("<provider>:<model>[@<endpoint>]:<effort>:<profile>");
    expect(refused("p1=google:gemini-4-argon:max:odysseus")).toContain(
      'effort must be one of low, medium, high, got "max"',
    );
    // Gemini returns at most 65 536 output tokens: twice the max_tokens retry must fit.
    expect(
      planError({
        fake: true,
        seed: 1,
        idKey: "seed",
        maxTokens: 40_000,
        seats: ["p1=google:gemini-4-argon:low:odysseus"],
      }),
    ).toContain(
      "p1: gemini-4-argon returns at most 65536 output tokens, under twice the lineup's maxTokens 40000",
    );
    expect(refused("p1=openai:gpt-7:medium:odysseus")).toContain("gpt-7 is not a seat model");
    // A real run: no --price-date, no provider without an adapter, a key per provider.
    expect(
      planError(
        {
          seed: 1,
          idKey: "seed",
          priceDate: "2026-10-19",
          seats: ["p1=claude:haiku-5-5:low:odysseus"],
        },
        { PERFIDIA_ANTHROPIC_API_KEY: "k" },
      ),
    ).toContain("--price-date applies to --fake runs and arena estimate");
    expect(
      refused(
        "p1=claude:haiku-5-5:low:odysseus",
        { ANTHROPIC_API_KEY: "k", PERFIDIA_OPENAI_API_KEY: "k" },
        false,
      ),
    ).toContain("PERFIDIA_ANTHROPIC_API_KEY is not set: the LLM seats (p1, p2, p3, p4) need it");
    // Pass 2: every provider has an adapter; a real run of it needs its own key.
    expect(
      refused(
        "p1=google:gemini-3.8-flash:low:odysseus",
        { PERFIDIA_ANTHROPIC_API_KEY: "k" },
        false,
      ),
    ).toContain("PERFIDIA_GOOGLE_API_KEY is not set: the LLM seats (p1) need it");
    expect(
      refused("p1=openai:gpt-6-luna:low:odysseus", { PERFIDIA_ANTHROPIC_API_KEY: "k" }, false),
    ).toContain("PERFIDIA_OPENAI_API_KEY is not set: the LLM seats (p1) need it");
  });
});
