import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { findRuleset } from "@perfidia/engine";
import { toolDefinitions } from "@perfidia/gateway/runtime";
import { PlayerIdSchema } from "@perfidia/protocol";
import { EXIT, UsageError, parseFlags, usageText, type CliIo, type FlagSpecs } from "@perfidia/sim";
import { PlaytestError } from "./fork.ts";
import { renderSession } from "./render.ts";
import {
  assertFreeSessionDir,
  derive,
  newSession,
  readSession,
  replyFileOf,
  sessionRun,
  writeSession,
  type Derivation,
  type NewStep,
  type PlaytestCall,
  type SessionFile,
  type Step,
} from "./session.ts";

// `arena playtest` (a dev tool): an outside player, a person or an agent driving the command line,
// plays one LLM seat of a run turn by turn through the real harness, with no model API. `start`
// forks the run at a turn of the seat and writes the material of its first round trip; `reply`
// sends the calls (and text) of one reply, as the seat's model would; `next` lets the bots play on
// to the seat's next wake; `status` re-derives the session and rewrites its material. Exit codes as
// the arena's: 0 ok, 2 an error of the derivation, 3 a usage or session problem.

const START_FLAGS: FlagSpecs = {
  from: { type: "string", value: "<run-dir>", help: "the run (an arena run directory; only read)" },
  seat: { type: "string", value: "<pN>", help: "the LLM seat to play" },
  at: {
    type: "string",
    value: "<turn | time>",
    help: "its turn: a number (12, turn:12), or its first turn at or after a game time (D2 08:00, t:93600)",
  },
  out: { type: "string", value: "<dir>", help: "the session directory (new or empty)" },
  brain: {
    type: "string",
    repeat: true,
    value: "<pN=strategy@n>",
    help: "the bot of another seat (default: a bot seat's own, an LLM seat's hand-off bot)",
  },
};
const REPLY_FLAGS: FlagSpecs = {
  session: { type: "string", value: "<dir>", help: "the session directory" },
  calls: {
    type: "string",
    value: "<file.json>",
    help: 'the reply\'s calls: [{"name": "<tool>", "args": {...}}, ...] or {"text": "...", "calls": [...]}',
  },
  text: {
    type: "string",
    repeat: true,
    value: "<text>",
    help: "a text block of the reply, before its calls (the public thought when the reply ends the turn)",
  },
  end: {
    type: "boolean",
    help: "this reply ends the turn: it needs text, and no call or end_turn among its calls",
  },
};
const SESSION_FLAGS: FlagSpecs = {
  session: { type: "string", value: "<dir>", help: "the session directory" },
};

export const PLAYTEST_USAGE = [
  "usage: bun run arena -- playtest <start | reply | next | status> [flags]",
  "",
  "Play one LLM seat of a run turn by turn through the real harness, with no model API: the run is",
  "forked at a turn of the seat (its match.jsonl replayed), the seat's LlmSeatAgent asks you for each",
  "reply, your calls run through the gateway, and bots play the other seats.",
  "",
  usageText(
    "arena playtest start --from <run-dir> --seat <pN> --at <turn | time> --out <dir>",
    START_FLAGS,
  ),
  usageText(
    "arena playtest reply --session <dir> [--calls <file.json>] [--text <text>] [--end]",
    REPLY_FLAGS,
  ),
  usageText(
    "arena playtest next --session <dir>   (bots play on to the seat's next wake)",
    SESSION_FLAGS,
  ),
  usageText(
    "arena playtest status --session <dir>   (re-derive the session, rewrite its material)",
    SESSION_FLAGS,
  ),
].join("\n");

/** A session that does not derive (exit 2): its message is the whole report. */
class DerivationError extends Error {
  override readonly name = "DerivationError";
}

function required(value: string | undefined, flag: string): string {
  if (value === undefined) throw new UsageError(`${flag} is required\n\n${PLAYTEST_USAGE}`);
  return value;
}

function brainsOfFlags(values: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const v of values) {
    const m = /^(p[1-9][0-9]*)=(?:bot:)?([a-z][a-z0-9-]*(?:@[1-9][0-9]*)?)$/.exec(v);
    if (m === null || m[1] === undefined || m[2] === undefined) {
      throw new UsageError(`--brain must be pN=strategy@n (e.g. p3=turtle@3), got "${v}"`);
    }
    out[m[1]] = m[2];
  }
  return out;
}

/** Derives the session with its steps and `step`, and keeps it only when `step` was consumed. */
async function advance(
  dir: string,
  session: SessionFile,
  steps: readonly Step[],
  step: NewStep,
  loaded: ReturnType<typeof sessionRun> = sessionRun(session),
): Promise<Derivation> {
  const d = await derive(session, [...steps, step], loaded);
  if (d.halt.kind === "error") throw new DerivationError(d.halt.message);
  if (d.unconsumed > 0) {
    const h = d.halt;
    const why =
      h.kind === "turn_ended"
        ? `turn ${h.turn} of ${session.seat} is over: run \`playtest next\` to play on to its next turn`
        : h.kind === "await_reply"
          ? `turn ${h.turn} waits for the reply of round trip ${h.round + 1}: \`next\` plays on only once a turn has ended`
          : h.kind === "match_ended"
            ? "the match has ended: no turn is left to play"
            : "the session cannot take this step";
    throw new UsageError(why);
  }
  writeSession(dir, session, d.steps);
  return d;
}

function report(io: CliIo, dir: string, session: SessionFile, d: Derivation): number {
  const lines = renderSession(dir, session, d);
  for (const l of lines) io.out(`${l}\n`);
  return EXIT.ok;
}

async function start(argv: readonly string[], io: CliIo): Promise<number> {
  const f = parseFlags(argv, START_FLAGS, PLAYTEST_USAGE, { min: 0, max: 0, name: "positional" });
  const from = required(f.string("from"), "--from");
  const seatText = required(f.string("seat"), "--seat");
  const at = required(f.string("at"), "--at");
  const out = resolve(required(f.string("out"), "--out"));
  const seat = PlayerIdSchema.safeParse(seatText);
  if (!seat.success) throw new UsageError(`--seat must be a seat id like p2, got "${seatText}"`);
  assertFreeSessionDir(out);
  const session = newSession(from, seat.data, at, brainsOfFlags(f.strings("brain")));
  const d = await derive(session, []);
  if (d.halt.kind === "error") throw new DerivationError(d.halt.message);
  if (d.halt.kind !== "await_reply") {
    throw new PlaytestError(`the fork did not open ${seat.data}'s turn ${session.target.turn}`);
  }
  mkdirSync(out, { recursive: true });
  writeSession(out, session, d.steps);
  io.out(
    `playtest of ${session.seat} from turn ${session.target.turn} of ${session.run}${d.fork.closed.length === 0 ? "" : ` (cut mid-second: the open turns of ${d.fork.closed.join(", ")} were closed as empty rounds)`}\n`,
  );
  io.out(`prompt: ${resolve(out, "prompt.md")}, tools: ${resolve(out, "tools.json")}\n`);
  return report(io, out, session, d);
}

function replyStep(f: ReturnType<typeof parseFlags>, toolNames: ReadonlySet<string>): NewStep {
  const file = f.string("calls");
  let fromFile: { readonly text: readonly string[]; readonly calls: readonly PlaytestCall[] } = {
    text: [],
    calls: [],
  };
  if (file !== undefined) {
    let value: unknown;
    try {
      value = JSON.parse(readFileSync(file, "utf8"));
    } catch (e) {
      throw new UsageError(`--calls ${file}: ${e instanceof Error ? e.message : String(e)}`);
    }
    fromFile = replyFileOf(value, file);
  }
  const text = [...fromFile.text, ...f.strings("text")].filter((t) => t !== "");
  const calls = fromFile.calls;
  for (const c of calls) {
    if (!toolNames.has(c.name)) {
      throw new UsageError(
        `${c.name} is not a tool of this seat (a model can only call its tools): ${[...toolNames].join(", ")}`,
      );
    }
  }
  if (f.bool("end")) {
    if (text.length === 0) throw new UsageError("--end needs text: the public thought (--text)");
    if (calls.length > 0 && !calls.some((c) => c.name === "end_turn")) {
      throw new UsageError(
        '--end: a reply with calls ends the turn only with an end_turn call (add {"name": "end_turn", "args": {}}), or send no call',
      );
    }
  }
  if (file === undefined && text.length === 0) {
    throw new UsageError(`give --calls <file.json>, --text, or both\n\n${PLAYTEST_USAGE}`);
  }
  return { k: "reply", text, calls };
}

async function reply(argv: readonly string[], io: CliIo): Promise<number> {
  const f = parseFlags(argv, REPLY_FLAGS, PLAYTEST_USAGE, { min: 0, max: 0, name: "positional" });
  const dir = resolve(required(f.string("session"), "--session"));
  const { session, steps } = readSession(dir);
  const loaded = sessionRun(session);
  const ruleset = findRuleset(loaded.run.header.setup.ruleset);
  if (ruleset === undefined) throw new PlaytestError("the run's ruleset is not in this build");
  const names = new Set(toolDefinitions(ruleset).map((t) => t.name));
  const d = await advance(dir, session, steps, replyStep(f, names), loaded);
  return report(io, dir, session, d);
}

async function next(argv: readonly string[], io: CliIo): Promise<number> {
  const f = parseFlags(argv, SESSION_FLAGS, PLAYTEST_USAGE, { min: 0, max: 0, name: "positional" });
  const dir = resolve(required(f.string("session"), "--session"));
  const { session, steps } = readSession(dir);
  const d = await advance(dir, session, steps, { k: "next" });
  return report(io, dir, session, d);
}

async function status(argv: readonly string[], io: CliIo): Promise<number> {
  const f = parseFlags(argv, SESSION_FLAGS, PLAYTEST_USAGE, { min: 0, max: 0, name: "positional" });
  const dir = resolve(required(f.string("session"), "--session"));
  const { session, steps } = readSession(dir);
  const d = await derive(session, steps);
  if (d.halt.kind === "error") throw new DerivationError(d.halt.message);
  if (d.unconsumed > 0) {
    throw new DerivationError(
      `the session's last ${d.unconsumed} step(s) no longer replay (the derivation stops at ${d.halt.kind})`,
    );
  }
  return report(io, dir, session, d);
}

/** `arena playtest <sub> …`; a `PlaytestError` is a usage error (exit 3). */
export async function playtestCommand(argv: readonly string[], io: CliIo): Promise<number> {
  const [sub, ...rest] = argv;
  try {
    switch (sub) {
      case "start":
        return await start(rest, io);
      case "reply":
        return await reply(rest, io);
      case "next":
        return await next(rest, io);
      case "status":
        return await status(rest, io);
      case undefined:
      case "help":
        io.out(PLAYTEST_USAGE);
        return EXIT.ok;
      default:
        throw new UsageError(`unknown playtest command "${sub}"\n\n${PLAYTEST_USAGE}`);
    }
  } catch (e) {
    if (e instanceof PlaytestError) throw new UsageError(e.message);
    if (e instanceof DerivationError) {
      io.err(`arena playtest ${sub ?? ""}: ${e.message}\n`);
      return EXIT.fatal;
    }
    throw e;
  }
}
