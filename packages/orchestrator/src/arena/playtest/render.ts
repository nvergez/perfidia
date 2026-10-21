import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fmtTime } from "@perfidia/engine/core";
import type { ToolResult } from "@perfidia/protocol";
import type { Derivation, RoundRecord, SessionFile, TurnRecord } from "./session.ts";

// The material of a playtest session, as files a person or an agent reads:
//
//   prompt.md              the request's two system blocks (shared, then the seat's profile)
//   tools.json             the request's tool list (names, descriptions, JSON schemas)
//   turn-NNN/round-R.md    what round trip R+1 of turn NNN adds to the conversation: round 0 the
//                          briefing and the turn header; later rounds the reply echoed back, the
//                          tool results and the round reminder, after a summary of the results
//   turn-NNN/request-R.json  the whole request of that round trip, as the request builder makes it
//   turn-NNN/end.md        how the turn ended, its last results (never shown to the model) and the
//                          gateway's record of it (the next briefing's lastTurn)
//   fork.jsonl             the fork's own log since the cut (the bots' play, the seat's actions)
//   STATUS.md              where the session stands and the command that moves it on
//
// Texts are quoted inside fenced blocks byte for byte: what sits between a fence's opening line
// and its closing line is the request's string, unchanged (the fence is longer than any run of
// backticks in it).

/** A text block the request carries, inside a fence no backtick run of it can close. */
export function fenced(text: string, info = ""): string {
  let n = 3;
  for (const m of text.matchAll(/`+/g)) n = Math.max(n, m[0].length + 1);
  const f = "`".repeat(n);
  return `${f}${info}\n${text}\n${f}`;
}

type Block =
  | { readonly kind: "text"; readonly text: string }
  | {
      readonly kind: "result";
      readonly id: string;
      readonly content: string;
      readonly isError: boolean;
    }
  | { readonly kind: "call"; readonly id: string; readonly name: string; readonly input: unknown }
  | { readonly kind: "other"; readonly json: string };

interface Message {
  readonly role: string;
  readonly blocks: readonly Block[];
}

const get = (o: unknown, key: string): unknown =>
  o !== null && typeof o === "object" ? Reflect.get(o, key) : undefined;
const str = (v: unknown): string => (typeof v === "string" ? v : "");

function blockOf(b: unknown): Block {
  const type = get(b, "type") ?? get(b, "kind");
  if (type === "text") return { kind: "text", text: str(get(b, "text")) };
  if (type === "tool_result" || type === "result") {
    const content = get(b, "content");
    return {
      kind: "result",
      id: str(get(b, "tool_use_id") ?? get(b, "callId")),
      content: typeof content === "string" ? content : JSON.stringify(content),
      isError: get(b, "is_error") === true || get(b, "isError") === true,
    };
  }
  if (type === "tool_use") {
    return {
      kind: "call",
      id: str(get(b, "id")),
      name: str(get(b, "name")),
      input: get(b, "input"),
    };
  }
  return { kind: "other", json: JSON.stringify(b) };
}

/** The messages of a request body (the Anthropic layout, or the fake adapter's neutral one). */
export function messagesOf(body: unknown): Message[] {
  const messages = get(body, "messages");
  if (!Array.isArray(messages)) return [];
  return messages.map((m: unknown) => {
    const content = get(m, "content");
    const blocks: Block[] =
      typeof content === "string"
        ? [{ kind: "text", text: content }]
        : Array.isArray(content)
          ? content.map((b: unknown) => blockOf(b))
          : [];
    return { role: str(get(m, "role")), blocks };
  });
}

/** The system blocks' texts of a request body. */
export function systemOf(body: unknown): string[] {
  const system = get(body, "system");
  return Array.isArray(system) ? system.map((b: unknown) => str(get(b, "text"))) : [];
}

const turnDir = (turn: number): string => `turn-${String(turn).padStart(3, "0")}`;

const oneLine = (s: string, max = 300): string => {
  const t = s.replaceAll(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

const rejection = (code: unknown, message: unknown, hint: unknown): string =>
  `${str(code)}: ${oneLine(str(message))}${str(hint) === "" ? "" : ` Hint: ${oneLine(str(hint))}`}`;

/** A success's verdict: `ok`, with the rejected items of a batch (each item is checked on its own). */
function okVerdict(r: Extract<ToolResult, { readonly ok: true }>): string {
  const items = get(r.data, "items");
  if (!Array.isArray(items)) return "ok";
  const failed = items.flatMap((it: unknown, i) =>
    get(it, "ok") === false
      ? [`item ${i + 1} ${rejection(get(it, "code"), get(it, "message"), get(it, "hint"))}`]
      : [],
  );
  return failed.length === 0
    ? "ok"
    : `ok, ${failed.length} of ${items.length} item(s) rejected: ${failed.join("; ")}`;
}

/** One line per call of a round: the call, and its result's verdict. */
function summary(rec: RoundRecord): string[] {
  const calls = rec.out?.calls ?? [];
  const results = rec.results ?? [];
  return calls.map((c, i) => {
    const r = results[i];
    const verdict =
      r === undefined
        ? "no result"
        : r.ok
          ? okVerdict(r)
          : `rejected ${rejection(r.code, r.message, r.hint)}`;
    return `${i + 1}. ${c.tool} ${oneLine(JSON.stringify(c.args ?? {}), 200)} → ${verdict}`;
  });
}

function sizeOf(rec: RoundRecord): string {
  const bytes = new TextEncoder().encode(rec.bodyText).length;
  return `${bytes.toLocaleString("en-US")} bytes, about ${Math.ceil(bytes / 4).toLocaleString("en-US")} tokens at 4 bytes a token`;
}

function renderMessage(
  i: number,
  m: Message,
  calls: ReadonlyMap<string, string>,
  round: number,
): string {
  const out: string[] = [];
  const results = m.blocks.filter((b) => b.kind === "result").length;
  const what =
    m.role === "assistant"
      ? `assistant (your reply of round trip ${round}, echoed back as the model's own)`
      : m.role === "user" && results > 0
        ? `user (${results} tool result${results === 1 ? "" : "s"})`
        : m.role === "user"
          ? "user (game data)"
          : `${m.role} (harness text)`;
  out.push(`## messages[${i}] · ${what}`);
  for (const b of m.blocks) {
    switch (b.kind) {
      case "text": {
        const json = b.text.startsWith("{") ? "json" : "text";
        out.push("", `text:`, "", fenced(b.text, json));
        break;
      }
      case "result":
        out.push(
          "",
          `tool_result for ${b.id}${calls.has(b.id) ? ` (${calls.get(b.id) ?? ""})` : ""}${b.isError ? " · is_error" : ""}:`,
          "",
          fenced(b.content, "json"),
        );
        break;
      case "call":
        out.push(
          "",
          `tool_use ${b.id}: ${b.name}`,
          "",
          fenced(JSON.stringify(b.input ?? {}), "json"),
        );
        break;
      case "other":
        out.push("", "other block:", "", fenced(b.json, "json"));
        break;
    }
  }
  return out.join("\n");
}

const replyCommand = (dir: string): string =>
  `bun run arena -- playtest reply --session ${dir} --calls <file.json> [--text "..."] [--end]`;
const nextCommand = (dir: string): string => `bun run arena -- playtest next --session ${dir}`;

const HOW_TO_REPLY = (dir: string): string =>
  [
    "Your move: write the calls of your reply to a JSON file, an array of",
    '`{"name": "<tool>", "args": {...}}` (or `{"text": "...", "calls": [...]}`), and run',
    "",
    `    ${replyCommand(dir)}`,
    "",
    "A reply with no call, or with end_turn among its calls, ends the turn: its text is the public",
    "thought (`--end` checks that it does). Its calls run in order through the gateway, exactly as a",
    "model's tool calls would.",
  ].join("\n");

function renderRound(
  dir: string,
  session: SessionFile,
  t: TurnRecord,
  rec: RoundRecord,
  prev: RoundRecord | undefined,
  exact: boolean,
): string {
  const maxRounds = rec.request.meta.maxRounds;
  const lines: string[] = [
    `# ${session.seat} · turn ${t.turn} · round trip ${rec.round + 1} of ${maxRounds} · ${fmtTime(t.wake.t)}`,
    "",
  ];
  if (prev !== undefined) {
    const s = summary(prev);
    lines.push(
      `Results of your round trip ${prev.round + 1} (${s.length} call${s.length === 1 ? "" : "s"}), as the gateway answered them:`,
      "",
      ...(s.length === 0 ? ["(no call)"] : s),
      "",
    );
  } else {
    lines.push(
      `Wake reasons: ${t.wake.reasons.join(", ")}${t.wake.urgent ? " (urgent)" : ""}. Up to ${rec.request.meta.maxCalls} calls in this round trip.`,
      "",
    );
  }
  const all = messagesOf(rec.body);
  const before = prev === undefined ? 0 : messagesOf(prev.body).length;
  const calls = new Map<string, string>();
  for (const m of all) {
    for (const b of m.blocks) if (b.kind === "call") calls.set(b.id, b.name);
  }
  lines.push(
    `The messages this round trip adds to the conversation, ${exact ? "exactly as the Anthropic adapter sends them" : "as the harness's neutral request builder lays them out (the provider's wire format differs in layout, not in text)"}, after the system blocks (prompt.md) and the tools (tools.json)${before > 0 ? ` and the ${before} earlier messages (round-${rec.round - 1}.md and before)` : ""}. The whole request: request-${rec.round}.json (${sizeOf(rec)}).`,
    "",
  );
  for (const [i, m] of all.entries()) {
    if (i < before) continue;
    lines.push(renderMessage(i, m, calls, rec.round), "");
  }
  lines.push("---", "", HOW_TO_REPLY(dir), "");
  return lines.join("\n");
}

function renderEnd(dir: string, session: SessionFile, t: TurnRecord): string {
  const end = t.end;
  if (end === null) return "";
  const line = end.line;
  const last = t.rounds.findLast((r) => r.out !== null);
  const next = line.next === null ? "none" : `${fmtTime(line.next.at)} (${line.next.kind})`;
  const lines = [
    `# ${session.seat} · turn ${t.turn} ended · ${fmtTime(line.t)}`,
    "",
    `- why: ${line.why}${line.error === undefined ? "" : ` (${line.error})`}`,
    `- round trips: ${line.rounds}, calls: ${line.calls}`,
    `- public thought: ${line.thought === undefined ? "(none)" : JSON.stringify(line.thought)}`,
    `- self-wake: ${line.selfAt === null ? "none" : fmtTime(line.selfAt)}${line.clamp === undefined ? "" : ` (asked ${line.clamp.requested}, clamped to ${fmtTime(line.clamp.at)})`}`,
    `- next wake: ${next}`,
    "",
  ];
  if (last !== undefined) {
    const s = summary(last);
    lines.push(
      `## Results of round trip ${last.round + 1} (the turn's last: never shown to the model)`,
      "",
      ...(s.length === 0 ? ["(no call)"] : s),
      "",
      fenced(JSON.stringify(last.results ?? [], null, 2), "json"),
      "",
    );
  }
  lines.push(
    "## The gateway's record of the turn (the next briefing's lastTurn reports it)",
    "",
    fenced(JSON.stringify(end.lastTurn, null, 2), "json"),
    "",
    "---",
    "",
    `Next: \`${nextCommand(dir)}\` lets the bots play the other seats until ${session.seat}'s next wake, and opens that turn.`,
    "",
  );
  return lines.join("\n");
}

function renderPrompt(session: SessionFile, d: Derivation, rec: RoundRecord): string {
  const [shared = "", seat = ""] = systemOf(rec.body);
  const s = d.setup;
  const model = `${s.spec.model}${s.provider === "anthropic" ? "" : ` on ${s.provider}`}, effort ${s.spec.effort}`;
  return [
    `# ${session.seat} · ${s.profile.name} · ${model}`,
    "",
    d.setup.exact
      ? "The two system blocks of every request of this seat, exactly as the Anthropic adapter sends them (`system[0]`, then `system[1]`, both cached); the tools are in tools.json."
      : `The two system blocks of every request of this seat, in the harness's neutral layout (this seat plays on ${s.provider}; harness text reaches it on the ${s.variant} channel); the tools are in tools.json.`,
    "",
    "## system[0]: the shared block (the same for every seat on this channel)",
    "",
    fenced(shared, "text"),
    "",
    "## system[1]: the seat block (this seat's private profile)",
    "",
    fenced(seat, "text"),
    "",
  ].join("\n");
}

function haltText(dir: string, session: SessionFile, d: Derivation): string[] {
  const h = d.halt;
  switch (h.kind) {
    case "await_reply": {
      const t = d.turns.find((x) => x.turn === h.turn);
      const r = t?.rounds.find((x) => x.round === h.round);
      const max = r?.request.meta.maxRounds ?? 0;
      return [
        `${session.seat} · turn ${h.turn} (${t === undefined ? "?" : fmtTime(t.wake.t)}) · round trip ${h.round + 1} of ${max}, up to ${r?.request.meta.maxCalls ?? 0} calls`,
        `read: ${join(dir, turnDir(h.turn), `round-${h.round}.md`)}`,
        `reply: ${replyCommand(dir)}`,
      ];
    }
    case "turn_ended": {
      const t = d.turns.find((x) => x.turn === h.turn);
      const line = t?.end?.line;
      return [
        `${session.seat} · turn ${h.turn} ended (${line?.why ?? "?"}) after ${line?.rounds ?? 0} round trip(s)${line?.thought === undefined ? "" : `: "${line.thought}"`}`,
        `read: ${join(dir, turnDir(h.turn), "end.md")}`,
        `next: ${nextCommand(dir)}`,
      ];
    }
    case "match_ended":
      return [
        `the match ended (${h.result.reason}; winners ${h.result.winners.join(", ") || "none"}): ${session.seat} has no further turn`,
      ];
    case "error":
      break;
  }
  return [`error: ${h.message}`];
}

/** Writes the material of `d` into the session directory; returns the status lines. */
export function renderSession(dir: string, session: SessionFile, d: Derivation): string[] {
  const first = d.turns[0]?.rounds[0];
  if (first !== undefined) {
    writeFileSync(join(dir, "prompt.md"), renderPrompt(session, d, first));
    writeFileSync(
      join(dir, "tools.json"),
      `${JSON.stringify(get(first.body, "tools") ?? [], null, 2)}\n`,
    );
  }
  for (const t of d.turns) {
    const sub = join(dir, turnDir(t.turn));
    mkdirSync(sub, { recursive: true });
    for (const [i, rec] of t.rounds.entries()) {
      writeFileSync(join(sub, `request-${rec.round}.json`), rec.bodyText);
      writeFileSync(
        join(sub, `round-${rec.round}.md`),
        renderRound(dir, session, t, rec, t.rounds[i - 1], d.setup.exact),
      );
    }
    if (t.end !== null) writeFileSync(join(sub, "end.md"), renderEnd(dir, session, t));
  }
  writeFileSync(join(dir, "fork.jsonl"), d.forkLines.map((l) => `${l}\n`).join(""));
  const status = haltText(dir, session, d);
  const s = d.setup;
  writeFileSync(
    join(dir, "STATUS.md"),
    [
      `# Playtest of ${session.seat} (${s.profile.name}, ${s.spec.model})`,
      "",
      `- run: ${session.run}`,
      `- from: turn ${session.target.turn} at ${fmtTime(session.target.t)} (--at ${session.at}); the fork replays the run's log up to ${session.target.mode === "second" ? "the start of that game second" : "that turn's wake line"}${d.fork.closed.length === 0 ? "" : `, where the open turns of ${d.fork.closed.join(", ")} were closed as empty rounds`}`,
      `- other seats: ${Object.entries(session.brains)
        .map(([seat, label]) => `${seat} ${label}`)
        .join(", ")}`,
      `- steps: ${d.steps.length} (${d.steps.filter((x) => x.k === "reply").length} replies, ${d.steps.filter((x) => x.k === "next").length} next)`,
      "",
      "## Now",
      "",
      ...status.map((l) => `- ${l}`),
      "",
    ].join("\n"),
  );
  return status;
}
