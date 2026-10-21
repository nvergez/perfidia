// `arena playtest` on a 1-day fake run (the rig's plan): the material of a turn is byte for byte
// the Anthropic adapter's request of the run's own turn (rebuilt independently from the run's
// transcript and prompt files); a scripted session (calls, results, end, next) through the real
// gateway; the gateway's explanatory errors and caps; sessions re-derive identically; and the run
// directory is never modified.

import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { sha256Hex } from "@perfidia/engine/core";
import {
  BriefingSchema,
  JsonObjectSchema,
  LogLineSchema,
  ToolResultSchema,
  z,
  type HeaderLine,
  type LogLine,
  type PlayerId,
} from "@perfidia/protocol";
import { memoryIo } from "@perfidia/sim";
import { SeatsFileSchema } from "../../log/schema.ts";
import type { ChatRequest, Entry, ModelSpec } from "../../model/adapter.ts";
import { AnthropicAdapter, AnthropicClient } from "../../model/anthropic.ts";
import { main } from "../cli.ts";
import { fakePlan, play, runDir } from "../rig.test.ts";
import { PlaytestError, findTarget, parseAt, readRunLog, type RunLog } from "./fork.ts";
import { fenced, messagesOf, systemOf } from "./render.ts";
import { SessionFileSchema, StepSchema } from "./session.ts";

let run = "";
let before: Map<string, string> = new Map();

/** Every file under `dir`: relative path → sha256, size and modification time. */
function fingerprint(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const s = statSync(p);
      if (s.isDirectory()) walk(p);
      else
        out.set(relative(dir, p), `${sha256Hex(readFileSync(p, "utf8"))}:${s.size}:${s.mtimeMs}`);
    }
  };
  walk(dir);
  return out;
}

beforeAll(async () => {
  const r = await play(fakePlan({ days: 1 }));
  run = r.outcome.paths.dir;
  before = fingerprint(run);
});

async function arena(...argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const io = memoryIo();
  const code = await main(["playtest", ...argv], io, {});
  return { code, out: io.stdout(), err: io.stderr() };
}

async function start(seat: string, at: string): Promise<string> {
  const dir = join(runDir("session"), "s");
  const r = await arena("start", "--from", run, "--seat", seat, "--at", at, "--out", dir);
  expect(r.err).toBe("");
  expect(r.code).toBe(0);
  return dir;
}

/** A reply file in a fresh directory. */
function callsFile(value: unknown): string {
  const path = runDir("calls.json");
  writeFileSync(path, JSON.stringify(value), { flag: "wx" });
  return path;
}

const read = (...p: string[]): string => readFileSync(join(...p), "utf8");

/** The texts between the fences of a rendered file, in order. */
function fencedTexts(md: string): string[] {
  const out: string[] = [];
  const lines = md.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const open = /^(`{3,})[a-z]*$/.exec(lines[i] ?? "");
    if (open === null) continue;
    const fence = open[1] ?? "";
    const end = lines.indexOf(fence, i + 1);
    out.push(lines.slice(i + 1, end).join("\n"));
    i = end;
  }
  return out;
}

const bodyOf = (dir: string, turn: number, round: number): unknown =>
  JSON.parse(read(dir, `turn-${String(turn).padStart(3, "0")}`, `request-${round}.json`));

const field = (o: unknown, key: string): unknown =>
  o !== null && typeof o === "object" ? Reflect.get(o, key) : undefined;

/** The briefing of a round-0 request: its first message's text. */
function briefingOf(body: unknown) {
  const first = messagesOf(body)[0]?.blocks[0];
  return BriefingSchema.parse(JSON.parse(first?.kind === "text" ? first.text : "null"));
}

/** A round-0 transcript record: the briefing and the turn header. */
const RoundZeroSchema = z.looseObject({
  k: z.literal("request"),
  round: z.int(),
  entries: z.array(
    z.union([
      z.strictObject({
        role: z.literal("user"),
        parts: z.array(z.strictObject({ kind: z.literal("text"), text: z.string() })),
      }),
      z.strictObject({ role: z.literal("operator"), text: z.string() }),
    ]),
  ),
});

const ToolsSchema = z.array(
  z.strictObject({ name: z.string(), description: z.string(), inputSchema: JsonObjectSchema }),
);

/** The tool results of a request's last user message: [id, content, isError]. */
function resultsOf(body: unknown): { id: string; content: string; isError: boolean }[] {
  const user = messagesOf(body).findLast((m) => m.role === "user");
  return (user?.blocks ?? []).flatMap((b) =>
    b.kind === "result" ? [{ id: b.id, content: b.content, isError: b.isError }] : [],
  );
}

describe("arena playtest: the material is the adapter's request", () => {
  test("round 0 of a turn is byte for byte the Anthropic adapter's request of the run's own turn", async () => {
    const s = await start("p2", "3");
    // The run's own round-0 request of that turn, rebuilt from its transcript and prompt files.
    const first = read(run, "transcripts", "p2", "t3.jsonl")
      .split("\n")
      .filter((l) => l !== "")
      .flatMap((l) => {
        const r = RoundZeroSchema.safeParse(JSON.parse(l));
        return r.success && r.data.round === 0 ? [r.data] : [];
      })[0];
    const entries: Entry[] = first?.entries ?? [];
    expect(entries).toHaveLength(2);
    const seats = SeatsFileSchema.parse(JSON.parse(read(run, "seats.json")));
    const entry = seats.seats.find((x) => x.seat === "p2");
    if (entry?.kind !== "llm") throw new Error("p2 is an LLM seat");
    const spec: ModelSpec = {
      provider: "anthropic",
      model: entry.intended?.model ?? entry.model,
      effort: entry.effort,
      maxOutputTokens: entry.maxTokens,
      cacheTtl: "5m",
      fallbacks: entry.fallbacks ?? "default",
    };
    const adapter = new AnthropicAdapter(
      spec,
      new AnthropicClient({ apiKey: "test-no-key", baseURL: "http://127.0.0.1:9" }),
    );
    const req: ChatRequest = {
      prompt: { shared: read(run, "prompts", "shared.txt"), seat: read(run, "prompts", "p2.txt") },
      tools: ToolsSchema.parse(JSON.parse(read(run, "prompts", "tools.json"))),
      entries,
      meta: { seat: "p2", turn: 3, round: 0, maxRounds: 8, maxCalls: 10, kind: "round" },
    };
    const built = adapter.build(req);
    expect(read(s, "turn-003", "request-0.json")).toBe(JSON.stringify(built));
    // prompt.md quotes both system blocks byte for byte, tools.json is the request's tools, and
    // round-0.md quotes the briefing and the turn header byte for byte.
    expect(fencedTexts(read(s, "prompt.md"))).toEqual(systemOf(built));
    expect(JSON.parse(read(s, "tools.json"))).toEqual(JSON.parse(JSON.stringify(built.tools)));
    const texts = messagesOf(built).flatMap((m) =>
      m.blocks.flatMap((b) => (b.kind === "text" ? [b.text] : [])),
    );
    expect(texts).toHaveLength(2);
    expect(fencedTexts(read(s, "turn-003", "round-0.md"))).toEqual(texts);
    const session = SessionFileSchema.parse(JSON.parse(read(s, "session.json")));
    expect(session.target.turn).toBe(3);
    expect(read(s, "steps.jsonl")).toBe("");
  });

  test("a fence is longer than any backtick run of its text", () => {
    expect(fenced("a ``` b ```` c", "text")).toBe("`````text\na ``` b ```` c\n`````");
    expect(fencedTexts(fenced("x\n```\ny"))).toEqual(["x\n```\ny"]);
  });
});

describe("arena playtest: a scripted session through the real gateway", () => {
  let s = "";
  let city = "";

  test("start at a turn with an incoming proposal: the briefing shows it", async () => {
    s = await start("p2", "2");
    const briefing = briefingOf(bodyOf(s, 2, 0));
    expect(briefing.wake.reasons.some((r) => r.startsWith("proposal"))).toBe(true);
    expect(briefing.proposals.length).toBeGreaterThan(0);
    city = briefing.cities[0]?.id ?? "";
    expect(city).toMatch(/^c\d+$/);
  });

  test("reply: the calls run through the gateway and round-1.md shows what the model receives next", async () => {
    const r = await arena(
      "reply",
      "--session",
      s,
      "--calls",
      callsFile([
        { name: "view_city", args: { city } },
        { name: "write_note", args: { text: "playtest: watch p5", mode: "append" } },
      ]),
      "--text",
      "Looking around.",
    );
    expect(r.code).toBe(0);
    expect(r.out).toContain("round trip 2 of 8");
    const body = bodyOf(s, 2, 1);
    const results = resultsOf(body);
    expect(results.map((x) => x.id)).toEqual(["pt-p2-2-0-0", "pt-p2-2-0-1"]);
    expect(results.map((x) => x.isError)).toEqual([false, false]);
    const view = ToolResultSchema.parse(JSON.parse(results[0]?.content ?? "{}"));
    expect(view.ok).toBe(true);
    expect(field(view.ok ? view.data : null, "id")).toBe(city);
    // The assistant entry echoes the reply; the round reminder follows the results.
    const messages = messagesOf(body);
    expect(messages.map((m) => m.role)).toEqual(["user", "system", "assistant", "user", "system"]);
    expect(messages[2]?.blocks[0]).toEqual({ kind: "text", text: "Looking around." });
    const md = read(s, "turn-002", "round-1.md");
    expect(md).toContain(`1. view_city {"city":"${city}"} → ok`);
    expect(md).toContain("Round trip 2 of 8, up to 10 calls.");
    // The system blocks and tools are the same bytes in every request of the turn (cache prefix).
    const b0 = bodyOf(s, 2, 0);
    expect(JSON.stringify([field(body, "system"), field(body, "tools")])).toBe(
      JSON.stringify([field(b0, "system"), field(b0, "tools")]),
    );
  });

  test("--end closes the turn with its text as the public thought; end.md shows the last results", async () => {
    const thought = "Peace with p5 for now; I wake in an hour.";
    const r = await arena(
      "reply",
      "--session",
      s,
      "--calls",
      callsFile({ calls: [{ name: "end_turn", args: { nextWakeIn: 3600 } }] }),
      "--text",
      thought,
      "--end",
    );
    expect(r.code).toBe(0);
    expect(r.out).toContain("turn 2 ended (end_turn) after 2 round trip(s)");
    const end = read(s, "turn-002", "end.md");
    expect(end).toContain(`public thought: ${JSON.stringify(thought)}`);
    expect(end).toContain("1. end_turn");
    expect(end).toContain('"ended": "end_turn"');
    const turnLine = read(s, "fork.jsonl")
      .split("\n")
      .filter((l) => l !== "")
      .map((l) => LogLineSchema.parse(JSON.parse(l)))
      .find((l) => l.k === "turn" && l.seat === "p2");
    expect(turnLine).toMatchObject({ k: "turn", turn: 2, why: "end_turn", rounds: 2, thought });
    // A reply now is refused: the turn is over.
    const late = await arena("reply", "--session", s, "--text", "more?");
    expect(late.code).toBe(3);
    expect(late.err).toContain("turn 2 of p2 is over");
  });

  test("next: the bots play on to the seat's next wake; the next briefing carries the note and lastTurn", async () => {
    const r = await arena("next", "--session", s);
    expect(r.code).toBe(0);
    const briefing = briefingOf(bodyOf(s, 3, 0));
    expect(briefing.notes).toContain("playtest: watch p5");
    expect(briefing.lastTurn?.ended).toBe("end_turn");
    expect(r.out).toContain("p2 · turn 3");
    // `next` while a reply is awaited is refused.
    const again = await arena("next", "--session", s);
    expect(again.code).toBe(3);
    expect(again.err).toContain("waits for the reply of round trip 1");
    const steps = read(s, "steps.jsonl")
      .split("\n")
      .filter((l) => l !== "");
    expect(steps.map((l) => StepSchema.parse(JSON.parse(l)).k)).toEqual(["reply", "reply", "next"]);
  });

  test("status re-derives the session from the run and its steps, byte for byte", async () => {
    const files = fingerprintText(s);
    const r = await arena("status", "--session", s);
    expect(r.code).toBe(0);
    expect(fingerprintText(s)).toEqual(files);
  });

  test("a session whose steps no longer replay is refused, not drifted", async () => {
    const path = join(s, "steps.jsonl");
    const steps = read(path);
    writeFileSync(path, steps.replace(/"request":"[0-9a-f]{8}/, '"request":"00000000'));
    try {
      const r = await arena("status", "--session", s);
      expect(r.code).toBe(2);
      expect(r.err).toContain("the session no longer replays");
    } finally {
      writeFileSync(path, steps);
    }
  });
});

/** File texts of a session directory (modification times left out: `status` rewrites them). */
function fingerprintText(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const [k, v] of fingerprint(dir)) out.set(k, v.split(":").slice(0, 2).join(":"));
  return out;
}

describe("arena playtest: the gateway's explanatory errors and caps", () => {
  test("invalid calls get the gateway's code, message and hint; the 11th call of a round trip is over the call cap", async () => {
    const s = await start("p2", "4");
    const calls = [
      { name: "view_city", args: { city: "town-2" } },
      { name: "view_city", args: { city: "c999" } },
      { name: "recruit", args: { city: "c999", orders: [] } },
      { name: "send_message", args: { to: ["p9"], text: "hello" } },
      ...Array.from({ length: 7 }, () => ({ name: "leaderboard", args: {} })),
    ];
    const r = await arena("reply", "--session", s, "--calls", callsFile(calls));
    expect(r.code).toBe(0);
    const results = resultsOf(bodyOf(s, 4, 1)).map((x) => ({
      isError: x.isError,
      r: ToolResultSchema.parse(JSON.parse(x.content)),
    }));
    expect(results).toHaveLength(11);
    const codes = results.map((x) => (x.r.ok ? "ok" : x.r.code));
    expect(codes.slice(0, 3)).toEqual(["INVALID_ARGS", "UNKNOWN_ID", "INVALID_ARGS"]);
    expect(codes[3]).toBeDefined();
    expect(codes[3]).not.toBe("ok");
    expect(codes.slice(4, 10)).toEqual(Array.from({ length: 6 }, () => "ok"));
    expect(codes[10]).toBe("CALLS_CAP");
    for (const x of results) {
      expect(x.isError).toBe(!x.r.ok);
      if (x.r.ok) continue;
      expect(x.r.message.length).toBeGreaterThan(10);
      expect(x.r.hint.length).toBeGreaterThan(5);
    }
    const md = read(s, "turn-004", "round-1.md");
    expect(md).toContain('2. view_city {"city":"c999"} → rejected UNKNOWN_ID: No city c999');
    expect(md).toContain("11. leaderboard {} → rejected CALLS_CAP");
  });

  test("the command line refuses what a model could not send", async () => {
    const s = await start("p2", "5");
    const unknown = await arena(
      "reply",
      "--session",
      s,
      "--calls",
      callsFile([{ name: "teleport", args: {} }]),
    );
    expect(unknown.code).toBe(3);
    expect(unknown.err).toContain("teleport is not a tool of this seat");
    const noText = await arena("reply", "--session", s, "--end", "--calls", callsFile([]));
    expect(noText.code).toBe(3);
    expect(noText.err).toContain("--end needs text");
    const noEnd = await arena(
      "reply",
      "--session",
      s,
      "--end",
      "--text",
      "Done.",
      "--calls",
      callsFile([{ name: "leaderboard", args: {} }]),
    );
    expect(noEnd.code).toBe(3);
    expect(noEnd.err).toContain("end_turn");
    const notObject = await arena(
      "reply",
      "--session",
      s,
      "--calls",
      callsFile([{ name: "leaderboard", args: [1] }]),
    );
    expect(notObject.code).toBe(3);
    // Nothing was recorded by the refused replies.
    expect(read(s, "steps.jsonl")).toBe("");
  });

  test("start refuses a bot seat, a turn the seat never had and a used directory", async () => {
    const bot = await arena(
      "start",
      "--from",
      run,
      "--seat",
      "p5",
      "--at",
      "2",
      "--out",
      join(runDir("x"), "s"),
    );
    expect(bot.code).toBe(3);
    expect(bot.err).toContain("is played by bot:opportunist@3, not by an LLM seat");
    const late = await arena(
      "start",
      "--from",
      run,
      "--seat",
      "p2",
      "--at",
      "999",
      "--out",
      join(runDir("x"), "s"),
    );
    expect(late.code).toBe(3);
    expect(late.err).toContain("p2 has no turn 999");
    const used = await start("p1", "D1 02:00");
    const again = await arena("start", "--from", run, "--seat", "p1", "--at", "2", "--out", used);
    expect(again.code).toBe(3);
    expect(again.err).toContain("not empty");
  });
});

/** A log of a few lines after the run's own header, its controllers replaced. */
function logOf(lines: readonly LogLine[]): RunLog {
  const header: HeaderLine = {
    ...readRunLog(run).header,
    controllers: { p1: "llm:x", p2: "llm:y", p3: "bot:turtle@3" },
  };
  const all = [header, ...lines];
  return { dir: "", path: "match.jsonl", sha256: "", texts: [], lines: all, header };
}

/** An event line of the run, at `t`. */
function ev(t: number): LogLine {
  const e = readRunLog(run).lines.find((l) => l.k === "ev");
  if (e?.k !== "ev") throw new Error("the run has no event");
  return { ...e, t };
}

const wake = (t: number, seat: PlayerId, turn: number): LogLine => ({
  k: "wake",
  t,
  seat,
  turn,
  reasons: ["self"],
  urgent: false,
  charge: "own",
  day: 0,
  used: { own: 1, social: 0 },
});

describe("arena playtest: targets", () => {
  test("--at reads a turn, a game second or a game time", () => {
    expect(parseAt("12")).toEqual({ kind: "turn", turn: 12 });
    expect(parseAt("turn:12")).toEqual({ kind: "turn", turn: 12 });
    expect(parseAt("t:93600")).toEqual({ kind: "time", t: 93600 });
    expect(parseAt("D2 02:00")).toEqual({ kind: "time", t: 93600 });
    expect(parseAt("D2T02:00:30")).toEqual({ kind: "time", t: 93630 });
    expect(() => parseAt("tomorrow")).toThrow(PlaytestError);
    expect(() => parseAt("D2 25:00")).toThrow(PlaytestError);
  });

  test("a wake of the second's first batch cuts at the second's start; a later one at its own line", () => {
    const log = logOf([
      ev(50),
      wake(50, "p1", 4),
      wake(50, "p2", 7),
      { k: "batch", t: 50, b: 0, order: ["p1", "p2"] },
      wake(50, "p1", 5),
      {
        k: "turn",
        t: 50,
        seat: "p1",
        turn: 5,
        rounds: 1,
        calls: 0,
        why: "empty_round",
        selfAt: null,
        next: null,
      },
      wake(60, "p2", 8),
      wake(70, "p3", 1),
    ]);
    expect(findTarget(log, "p2", { kind: "turn", turn: 7 })).toMatchObject({
      mode: "second",
      cut: 2,
      wakeIndex: 3,
    });
    expect(findTarget(log, "p1", { kind: "turn", turn: 5 })).toMatchObject({
      mode: "mid-second",
      cut: 5,
      wakeIndex: 5,
    });
    expect(findTarget(log, "p2", { kind: "time", t: 55 })).toMatchObject({ turn: 8, cut: 7 });
    expect(() => findTarget(log, "p3", { kind: "turn", turn: 1 })).toThrow("bot:turtle@3");
    expect(() => findTarget(log, "p9", { kind: "turn", turn: 1 })).toThrow("not a seat");
  });
});

test("the run directory is never modified by a playtest", () => {
  expect(before.size).toBeGreaterThan(5);
  expect(fingerprint(run)).toEqual(before);
});
