import {
  MATCH_STATS_FORMAT,
  type FeedItem,
  type Frame,
  type HandoffReason,
  type HeaderLine,
  type LlmCallLine,
  type LlmLogLine,
  type MatchStats,
  type MatchStatus,
  type PeerCounts,
  type PlayerId,
  type SeatStats,
  type SeatsFile,
  type StatsModel,
  type StatsPercentiles,
  type StatsSeriesRef,
  type StatsTokens,
  type Step,
  type Verified,
} from "@perfidia/protocol";
import { LABEL_MAX_CHARS, cleanText, cutText } from "../clean.ts";
import { botIdOf, idPart, modelIdOf, modelKey, parseLabel, type LabelModel } from "./keys.ts";

// Per seat per match statistics (phase-4 design §6.1): a pure fold of what a match left behind.
// `match.jsonl` arrives already folded by the spectator fold (its steps' feed items and the frame
// after the last step), so every ruleset name stays in `fold/rulesets.ts` and the server reuses the
// steps its workers folded; `llm_calls.jsonl` and `seats.json` come as parsed lines, like the
// annotations. What it reads:
// - turns, rounds, calls, rejections, thoughts and endings from the feed's `turn` items (an LLM
//   seat's wakes are its turns while an LLM controlled it);
// - diplomacy from `message`, `proposal`, `answer`, `diplomacy` and `betrayal` items: a pact is kept
//   when it expired or was still active at the last line with no betrayal by the seat of that
//   partner meanwhile; a pact is broken by a betrayal of relation `pact`;
// - battles, conquests and foundings from their items; the hand-off from the `handoff` item (its
//   reason from the side file's `handoff` line);
// - the outcome from the frame (the end line's standings once the match ended) and its result;
// - attempts, stops, errors, refusals, tool-call errors, latency, reply characters, the
//   parallel-call share, wake and prompt caps, cost, tokens and price cards from `llm_call` and the
//   other side lines; the start preflight and probes split equally among the seats of their model.
// Costs, tokens and model time are left out (null) when `costs` is false (the server's
// `--no-costs`). Nothing here reads a prompt, a reply's text, an error message or a request id.

/** What the spectator fold made of `match.jsonl`. */
export interface FoldedMatch {
  readonly header: HeaderLine;
  readonly steps: readonly Step[];
  /** The frame after the last step. */
  readonly frame: Frame;
  readonly verified: Verified;
  /** The last game time of the log. */
  readonly lastT: number;
}

/** The side files of the run directory, parsed (each absent when the run has none). */
export interface StatsSide {
  /** `llm_calls.jsonl`; null when the run has none (a bot-only run). */
  readonly calls?: readonly LlmLogLine[] | null;
  readonly seats?: SeatsFile | null;
  /** `arena.json`'s cost by token kind per seat, when it parses. */
  readonly costByKind?: ReadonlyMap<PlayerId, CostByKind> | null;
  /** `arena.json` says `fake`. */
  readonly fake?: boolean;
}

export interface CostByKind {
  readonly input: number;
  readonly cacheWrite5m: number;
  readonly cacheWrite1h: number;
  readonly cacheRead: number;
  readonly output: number;
}

export interface MatchStatsOptions {
  /** The match id (its run directory's name). */
  readonly match: string;
  /** The match's status as the server shows it (`ended`, `stopped`, `degraded`, …). */
  readonly status: MatchStatus;
  /** Publish costs, tokens and model time (default true). */
  readonly costs?: boolean;
  /** The series match it is (`series.json`), if any. */
  readonly series?: StatsSeriesRef | null;
}

/** Sent message texts that name a model, a vendor or "language model" (decision 9: counted only). */
export const SELF_ID =
  /\b(?:claude|anthropic|chatgpt|gpt|openai|gemini|google|deepmind|glm|zhipu|kimi|moonshot|deepseek|llama|mistral|qwen|llms?|language models?)\b/i;

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** A label from a side file (an error kind, a refusal category), cleaned, cut and never `__proto__`. */
function labelOf(text: string | null | undefined, none: string): string {
  const out = cutText(cleanText(text ?? ""), LABEL_MAX_CHARS).trim();
  return out === "" || out === "__proto__" ? none : out;
}

function bump(m: Map<string, number>, key: string, by = 1): void {
  m.set(key, (m.get(key) ?? 0) + by);
}

/** Counts as a record with sorted keys. */
function record(m: ReadonlyMap<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of [...m.keys()].toSorted(byText)) out[k] = m.get(k) ?? 0;
  return out;
}

/** Nearest-rank p50 and p95 of integer samples; null without one. */
export function percentiles(values: readonly number[]): StatsPercentiles | null {
  if (values.length === 0) return null;
  const s = values.toSorted((a, b) => a - b);
  const at = (num: number): number => s[Math.max(0, Math.ceil((num * s.length) / 100) - 1)] ?? 0;
  return { n: s.length, p50: at(50), p95: at(95) };
}

/** Rounded permille of `part` over `whole`; null when `whole` is 0. */
function permille(part: number, whole: number): number | null {
  return whole === 0 ? null : Math.round((part * 1000) / whole);
}

const capitalised = (s: string): string =>
  s.length === 0 ? s : `${s[0]?.toUpperCase() ?? ""}${s.slice(1)}`;

/** `bot:opportunist@3` → `Opportunist (bot)`. */
function botName(label: string): string {
  const m = /^bot:([a-z][a-z0-9-]*)@[0-9]+$/.exec(label);
  return m?.[1] === undefined ? cleanText(label) : `${capitalised(m[1])} (bot)`;
}

interface SeatAcc {
  readonly seat: PlayerId;
  readonly llm: boolean;
  readonly key: string;
  /** Turns. */
  turns: number;
  wakes: number;
  rounds: number;
  calls: number;
  accepted: number;
  readonly rejections: Map<string, number>;
  thoughts: number;
  readonly endings: Map<string, number>;
  errorWakes: number;
  // Diplomacy.
  messagesSent: number;
  messagesReceived: number;
  publicSent: number;
  proposalsSent: number;
  proposalsReceived: number;
  accepted2: number;
  refused: number;
  alliancesFounded: number;
  alliancesJoined: number;
  alliancesLeft: number;
  pactsSigned: number;
  pactsKept: number;
  pactsBroken: number;
  readonly pactEnds: Map<string, number>;
  betrayalsCommitted: number;
  betrayalsSuffered: number;
  readonly same: { messages: number; pacts: number; alliances: number };
  readonly cross: { messages: number; pacts: number; alliances: number };
  selfIdentification: number;
  // Military.
  battlesAttacked: number;
  battlesDefended: number;
  battlesWon: number;
  citiesConquered: number;
  citiesLost: number;
  citiesFounded: number;
  // Incidents.
  handoff: { t: number; label: string } | null;
  handoffReason: HandoffReason | null;
  wakeCaps: number;
  promptCaps: number;
  // Calls.
  lines: number;
  attempts: number;
  thoughtCalls: number;
  readonly stops: Map<string, number>;
  readonly errors: Map<string, number>;
  readonly refusals: Map<string, number>;
  malformed: number;
  fallbacks: number;
  readonly latency: number[];
  readonly ttft: number[];
  textChars: number;
  reasoningChars: number;
  readonly reasoningKinds: Map<string, number>;
  toolRounds: number;
  parallelRounds: number;
  costNanoUsd: number;
  feesNanoUsd: number;
  reportedNanoUsd: number;
  reportedLines: number;
  estimatedNanoUsd: number;
  preflightNanoUsd: number;
  readonly tokens: StatsTokens;
  readonly priceCards: Set<string>;
  capNanoUsd: number | null;
}

function seatAcc(seat: PlayerId, llm: boolean, key: string): SeatAcc {
  return {
    seat,
    llm,
    key,
    turns: 0,
    wakes: 0,
    rounds: 0,
    calls: 0,
    accepted: 0,
    rejections: new Map(),
    thoughts: 0,
    endings: new Map(),
    errorWakes: 0,
    messagesSent: 0,
    messagesReceived: 0,
    publicSent: 0,
    proposalsSent: 0,
    proposalsReceived: 0,
    accepted2: 0,
    refused: 0,
    alliancesFounded: 0,
    alliancesJoined: 0,
    alliancesLeft: 0,
    pactsSigned: 0,
    pactsKept: 0,
    pactsBroken: 0,
    pactEnds: new Map(),
    betrayalsCommitted: 0,
    betrayalsSuffered: 0,
    same: { messages: 0, pacts: 0, alliances: 0 },
    cross: { messages: 0, pacts: 0, alliances: 0 },
    selfIdentification: 0,
    battlesAttacked: 0,
    battlesDefended: 0,
    battlesWon: 0,
    citiesConquered: 0,
    citiesLost: 0,
    citiesFounded: 0,
    handoff: null,
    handoffReason: null,
    wakeCaps: 0,
    promptCaps: 0,
    lines: 0,
    attempts: 0,
    thoughtCalls: 0,
    stops: new Map(),
    errors: new Map(),
    refusals: new Map(),
    malformed: 0,
    fallbacks: 0,
    latency: [],
    ttft: [],
    textChars: 0,
    reasoningChars: 0,
    reasoningKinds: new Map(),
    toolRounds: 0,
    parallelRounds: 0,
    costNanoUsd: 0,
    feesNanoUsd: 0,
    reportedNanoUsd: 0,
    reportedLines: 0,
    estimatedNanoUsd: 0,
    preflightNanoUsd: 0,
    tokens: { input: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 0, reasoning: 0 },
    priceCards: new Set(),
    capNanoUsd: null,
  };
}

/** Who a seat is as it started: from `seats.json`, else from its controller label. */
interface SeatIdentity {
  readonly kind: "llm" | "bot";
  readonly label: string;
  readonly key: string;
  readonly id: string;
  readonly name: string;
  readonly model: StatsModel | null;
  readonly profile: string | null;
  readonly variant: SeatStats["promptVariant"];
  readonly reminders: SeatStats["reminders"];
  readonly toolsHash: string | null;
  readonly fake: boolean;
}

function identityOf(
  header: HeaderLine,
  seat: PlayerId,
  seats: SeatsFile | null,
  runFake: boolean,
): SeatIdentity {
  const raw = header.controllers[seat] ?? "";
  const label = cleanText(raw);
  const file = seats?.seats.find((s) => s.seat === seat);
  const parsed: LabelModel | null = parseLabel(raw);
  if (file?.kind === "llm") {
    const model: StatsModel = {
      provider: file.provider,
      model: file.model,
      endpoint: file.endpoint ?? parsed?.endpoint ?? null,
      effort: file.effort,
      intended: file.intended?.provider ?? null,
      quantization: file.quantization ?? null,
      effortSent: file.effortSent ?? null,
    };
    const p = file.profile;
    return {
      kind: "llm",
      label,
      key: modelKey(model),
      id: modelIdOf(model),
      name: cleanText(p.name.split(",")[0]?.trim() ?? p.name),
      model,
      profile: `${p.id}@${p.version}`,
      variant: file.promptVariant ?? parsed?.variant ?? "system",
      reminders: file.reminders ?? null,
      toolsHash: file.toolsHash ?? null,
      fake: runFake || file.provider === "fake",
    };
  }
  if (parsed !== null) {
    const model: StatsModel = {
      provider: parsed.provider,
      model: parsed.model,
      endpoint: parsed.endpoint,
      effort: parsed.effort,
      intended: null,
      quantization: null,
      effortSent: null,
    };
    const profileName = parsed.profile.slice(0, parsed.profile.indexOf("@"));
    return {
      kind: "llm",
      label,
      key: modelKey(model),
      id: modelIdOf(model),
      name: capitalised(profileName),
      model,
      profile: parsed.profile,
      variant: parsed.variant,
      reminders: null,
      toolsHash: null,
      fake: runFake || parsed.provider === "fake",
    };
  }
  if (raw.startsWith("llm:")) {
    return {
      kind: "llm",
      label,
      key: label,
      id: `llm.${idPart(raw.slice(4))}`,
      name: label,
      model: null,
      profile: null,
      variant: null,
      reminders: null,
      toolsHash: null,
      fake: runFake,
    };
  }
  return {
    kind: "bot",
    label,
    key: label,
    id: botIdOf(raw),
    name: botName(raw),
    model: null,
    profile: null,
    variant: null,
    reminders: null,
    toolsHash: null,
    fake: false,
  };
}

const pairKey = (a: string, b: string): string => (a < b ? `${a}|${b}` : `${b}|${a}`);

interface OpenPact {
  readonly a: PlayerId;
  readonly b: PlayerId;
  readonly betrayedBy: Set<PlayerId>;
}

/** The statistics of one match, seat by seat. */
export function matchStats(m: FoldedMatch, side: StatsSide, o: MatchStatsOptions): MatchStats {
  const costs = o.costs !== false;
  const header = m.header;
  const seatIds = header.setup.seats.map((s) => s.id);
  const seatsFile = side.seats ?? null;
  const runFake = side.fake === true;
  const ids = new Map<PlayerId, SeatIdentity>();
  const accs = new Map<string, SeatAcc>();
  for (const seat of seatIds) {
    const who = identityOf(header, seat, seatsFile, runFake);
    ids.set(seat, who);
    accs.set(seat, seatAcc(seat, who.kind === "llm", who.key));
  }
  const acc = (seat: string): SeatAcc | undefined => accs.get(seat);
  const llmKey = (seat: string): string | null => {
    const a = acc(seat);
    return a !== undefined && a.llm ? a.key : null;
  };
  /** Same model, another model, or not two LLM seats. */
  const peer = (a: string, b: string): "same" | "cross" | null => {
    const ka = llmKey(a);
    const kb = llmKey(b);
    if (ka === null || kb === null || a === b) return null;
    return ka === kb ? "same" : "cross";
  };
  const together: { same: PeerCounts; cross: PeerCounts } = {
    same: { messages: 0, pacts: 0, alliances: 0 },
    cross: { messages: 0, pacts: 0, alliances: 0 },
  };
  const shared = (a: string, b: string, what: keyof PeerCounts, both: boolean): void => {
    const p = peer(a, b);
    if (p === null) return;
    const sa = acc(a);
    const sb = acc(b);
    if (sa !== undefined) sa[p][what] += 1;
    if (both && sb !== undefined) sb[p][what] += 1;
    together[p][what] += 1;
  };

  const members = new Map<string, string[]>();
  const pacts = new Map<string, OpenPact>();
  let endedAt: number | null = null;
  const closePact = (a: string, b: string, kept: boolean): void => {
    const key = pairKey(a, b);
    const open = pacts.get(key);
    if (open === undefined) return;
    pacts.delete(key);
    if (!kept) return;
    for (const p of [open.a, open.b]) {
      const s = acc(p);
      if (s !== undefined && !open.betrayedBy.has(p)) s.pactsKept += 1;
    }
  };

  const item = (it: FeedItem): void => {
    switch (it.k) {
      case "turn": {
        const s = acc(it.seat);
        if (s === undefined) return;
        s.turns += 1;
        if (!it.llm) return;
        s.wakes += 1;
        s.rounds += it.rounds;
        s.calls += it.calls;
        s.accepted += it.accepted;
        for (const r of it.rejected) bump(s.rejections, r.code, r.count);
        if (it.thought !== null) s.thoughts += 1;
        bump(s.endings, it.why);
        if (it.why === "error") s.errorWakes += 1;
        return;
      }
      case "message": {
        const s = acc(it.from);
        const to = it.to === "all" ? seatIds.filter((p) => p !== it.from) : it.to;
        if (s !== undefined) {
          s.messagesSent += 1;
          if (it.to === "all") s.publicSent += 1;
          if (SELF_ID.test(it.text)) s.selfIdentification += 1;
        }
        for (const p of to) {
          if (p === it.from) continue;
          const r = acc(p);
          if (r !== undefined) r.messagesReceived += 1;
          shared(it.from, p, "messages", false);
        }
        return;
      }
      case "proposal": {
        const from = acc(it.from);
        const to = acc(it.to);
        if (from !== undefined) from.proposalsSent += 1;
        if (to !== undefined) to.proposalsReceived += 1;
        return;
      }
      case "answer": {
        const to = acc(it.to);
        if (to === undefined) return;
        if (it.accept) to.accepted2 += 1;
        else to.refused += 1;
        return;
      }
      case "diplomacy":
        diplomacy(it);
        return;
      case "betrayal": {
        const by = acc(it.by);
        const against = acc(it.against);
        if (by !== undefined) {
          by.betrayalsCommitted += 1;
          if (it.relation === "pact") by.pactsBroken += 1;
        }
        if (against !== undefined) against.betrayalsSuffered += 1;
        pacts.get(pairKey(it.by, it.against))?.betrayedBy.add(it.by);
        return;
      }
      case "battle": {
        const att = acc(it.attacker);
        const def = it.defender === "neutral" ? undefined : acc(it.defender);
        if (att !== undefined) {
          att.battlesAttacked += 1;
          if (it.winner === "attacker") att.battlesWon += 1;
        }
        if (def !== undefined) {
          def.battlesDefended += 1;
          if (it.winner === "defender") def.battlesWon += 1;
        }
        return;
      }
      case "conquest": {
        const to = acc(it.to);
        if (to !== undefined) to.citiesConquered += 1;
        const from = it.from === null ? undefined : acc(it.from);
        if (from !== undefined) from.citiesLost += 1;
        return;
      }
      case "founding": {
        const s = acc(it.owner);
        if (s !== undefined) s.citiesFounded += 1;
        return;
      }
      case "handoff": {
        const s = acc(it.seat);
        if (s !== undefined && s.handoff === null && it.from.startsWith("llm:")) {
          s.handoff = { t: it.t, label: cleanText(it.label) };
        }
        return;
      }
      case "end":
        endedAt = it.t;
        return;
      case "expired":
      case "launch":
      case "siege":
      case "spy":
      case "elimination":
      case "countdown":
      case "event":
        return;
    }
  };

  const diplomacy = (it: Extract<FeedItem, { k: "diplomacy" }>): void => {
    switch (it.event) {
      case "alliance_formed": {
        for (const p of it.players) {
          const s = acc(p);
          if (s !== undefined) s.alliancesFounded += 1;
        }
        for (const [i, a] of it.players.entries()) {
          for (const b of it.players.slice(i + 1)) shared(a, b, "alliances", true);
        }
        if (it.alliance !== null) members.set(it.alliance, [...it.players]);
        return;
      }
      case "alliance_joined": {
        if (it.alliance === null) return;
        const known = members.get(it.alliance) ?? [];
        const joiner = it.players.find((p) => !known.includes(p));
        members.set(it.alliance, [...it.players]);
        if (joiner === undefined) return;
        const s = acc(joiner);
        if (s !== undefined) s.alliancesJoined += 1;
        for (const p of known) shared(joiner, p, "alliances", true);
        return;
      }
      case "alliance_left": {
        const leaver = it.players[0];
        if (leaver === undefined) return;
        const s = acc(leaver);
        if (s !== undefined) s.alliancesLeft += 1;
        if (it.alliance !== null) {
          members.set(
            it.alliance,
            (members.get(it.alliance) ?? []).filter((p) => p !== leaver),
          );
        }
        return;
      }
      case "alliance_dissolved":
        if (it.alliance !== null) members.delete(it.alliance);
        return;
      case "pact_signed": {
        const [a, b] = it.players;
        if (a === undefined || b === undefined) return;
        for (const p of [a, b]) {
          const s = acc(p);
          if (s !== undefined) s.pactsSigned += 1;
        }
        shared(a, b, "pacts", true);
        pacts.set(pairKey(a, b), { a, b, betrayedBy: new Set() });
        return;
      }
      case "pact_expired": {
        const [a, b] = it.players;
        if (a !== undefined && b !== undefined) closePact(a, b, true);
        return;
      }
      case "pact_ended": {
        const [a, b] = it.players;
        if (a === undefined || b === undefined) return;
        for (const p of [a, b]) {
          const s = acc(p);
          if (s !== undefined) bump(s.pactEnds, it.cause ?? "unknown");
        }
        closePact(a, b, false);
        return;
      }
      case "pact_renewed":
        return;
    }
  };

  for (const step of m.steps) for (const it of step.items ?? []) item(it);
  // Pacts still active at the last line are kept by whoever did not betray the partner.
  for (const open of pacts.values()) closePact(open.a, open.b, true);

  // The side file.
  const calls = side.calls ?? null;
  let preflightNanoUsd = 0;
  let probeNanoUsd = 0;
  let attemptsNanoUsd = 0;
  if (calls !== null) {
    const preflights: { key: string; cost: number }[] = [];
    for (const line of calls) {
      switch (line.k) {
        case "llm_call":
          attemptsNanoUsd += line.costNanoUsd;
          callLine(acc(line.seat), line);
          break;
        case "handoff": {
          const s = acc(line.seat);
          if (s !== undefined && s.handoffReason === null) s.handoffReason = line.reason;
          break;
        }
        case "wake_cap": {
          const s = acc(line.seat);
          if (s !== undefined) s.wakeCaps += 1;
          break;
        }
        case "prompt_cap": {
          const s = acc(line.seat);
          if (s !== undefined) s.promptCaps += 1;
          break;
        }
        case "preflight":
          if (line.phase === "start") preflightNanoUsd += line.costNanoUsd;
          else probeNanoUsd += line.costNanoUsd;
          preflights.push({
            key: `${line.provider}|${line.model}|${line.endpoint ?? ""}`,
            cost: line.costNanoUsd,
          });
          break;
        case "pause":
        case "kill_switch":
        case "operator":
        case "carry":
          break;
      }
    }
    // Each check's spend, split equally among the LLM seats of its model (in seat order).
    for (const p of preflights) {
      const group = seatIds.filter((seat) => {
        const mm = ids.get(seat)?.model;
        return (
          mm !== null &&
          mm !== undefined &&
          `${mm.provider}|${mm.model}|${mm.endpoint ?? ""}` === p.key
        );
      });
      if (group.length === 0) continue;
      const share = Math.floor(p.cost / group.length);
      let rest = p.cost - share * group.length;
      for (const seat of group) {
        const s = acc(seat);
        if (s === undefined) continue;
        s.preflightNanoUsd += share + (rest > 0 ? 1 : 0);
        if (rest > 0) rest -= 1;
      }
    }
  }

  const seats: SeatStats[] = seatIds.map((seat): SeatStats => {
    const who = ids.get(seat);
    const s = accs.get(seat);
    if (who === undefined || s === undefined) throw new Error(`no seat ${seat}`);
    return seatOut(m.frame, who, s, side, calls !== null, costs);
  });

  const llmSeats = seatIds.filter((seat) => llmKey(seat) !== null);
  let samePairs = 0;
  let crossPairs = 0;
  for (const [i, a] of llmSeats.entries()) {
    for (const b of llmSeats.slice(i + 1)) {
      if (peer(a, b) === "same") samePairs += 1;
      else crossPairs += 1;
    }
  }
  const result = m.frame.result;
  const verified = m.verified.ok;
  return {
    format: MATCH_STATS_FORMAT,
    match: o.match,
    ruleset: header.setup.ruleset,
    status: o.status,
    verified,
    rated: verified && result !== null && (o.status === "ended" || o.status === "degraded"),
    clock: header.clock.kind,
    lastT: m.lastT,
    endedAt,
    result: result === null ? null : { reason: result.reason, winners: [...result.winners] },
    fake: runFake || seats.some((s) => s.fake),
    lineup: o.series?.lineup ?? seatsFile?.lineup ?? null,
    series: o.series ?? null,
    published: { costs },
    seats,
    collusion: { samePairs, crossPairs, same: together.same, cross: together.cross },
    cost:
      !costs || calls === null
        ? null
        : {
            nanoUsd: attemptsNanoUsd + preflightNanoUsd + probeNanoUsd,
            preflightNanoUsd,
            probeNanoUsd,
            budgetNanoUsd: seatsFile?.budgetNanoUsd ?? null,
          },
  };
}

/** One `llm_call` line into its seat's counts. */
function callLine(s: SeatAcc | undefined, line: LlmCallLine): void {
  if (s === undefined) return;
  s.lines += 1;
  s.attempts += 1;
  if (line.kind === "thought_call") s.thoughtCalls += 1;
  bump(s.stops, line.stop);
  if (line.error !== null) bump(s.errors, labelOf(line.error.kind, "unknown"));
  if (line.stop === "refusal") bump(s.refusals, labelOf(line.refusal?.category, "uncategorised"));
  if (line.stop === "other") s.malformed += 1;
  if (line.fallback) s.fallbacks += 1;
  s.latency.push(line.latencyMs);
  if (line.ttftMs !== null) s.ttft.push(line.ttftMs);
  s.textChars += line.textChars;
  s.reasoningChars += line.reasoningChars;
  if (line.reasoningKind !== undefined) bump(s.reasoningKinds, line.reasoningKind);
  if (line.kind === "round" && line.calls >= 1) {
    s.toolRounds += 1;
    if (line.calls >= 2) s.parallelRounds += 1;
  }
  s.costNanoUsd += line.costNanoUsd;
  s.feesNanoUsd += line.feeNanoUsd ?? 0;
  if (line.reportedCostNanoUsd !== undefined) {
    s.reportedNanoUsd += line.reportedCostNanoUsd;
    s.reportedLines += 1;
  }
  if (line.usage.some((u) => u.estimated)) s.estimatedNanoUsd += line.costNanoUsd;
  for (const u of line.usage) {
    s.tokens.input += u.input;
    s.tokens.cacheWrite5m += u.cacheWrite5m;
    s.tokens.cacheWrite1h += u.cacheWrite1h;
    s.tokens.cacheRead += u.cacheRead;
    s.tokens.output += u.output;
    s.tokens.reasoning += u.reasoning ?? 0;
  }
  if (line.priceCard !== undefined) s.priceCards.add(labelOf(line.priceCard, "unknown"));
  s.capNanoUsd = line.capNanoUsd;
}

function seatOut(
  frame: Frame,
  who: SeatIdentity,
  s: SeatAcc,
  side: StatsSide,
  hasCalls: boolean,
  costs: boolean,
): SeatStats {
  const p = Object.hasOwn(frame.players, s.seat) ? frame.players[s.seat] : undefined;
  const winners = frame.result?.winners ?? [];
  const llm = who.kind === "llm";
  const operations: SeatStats["operations"] =
    !llm || !hasCalls
      ? null
      : {
          attempts: s.attempts,
          thoughtCalls: s.thoughtCalls,
          stops: record(s.stops),
          errors: record(s.errors),
          toolErrors: {
            malformed: s.malformed,
            invalidArgs: s.rejections.get("INVALID_ARGS") ?? 0,
          },
          fallbacks: s.fallbacks,
          toolRounds: s.toolRounds,
          parallelRounds: s.parallelRounds,
          textChars: s.textChars,
          reasoningChars: s.reasoningChars,
          reasoningKinds: record(s.reasoningKinds),
          latencyMs: costs ? percentiles(s.latency) : null,
          ttftMs: costs ? percentiles(s.ttft) : null,
        };
  const prompt =
    s.tokens.input + s.tokens.cacheWrite5m + s.tokens.cacheWrite1h + s.tokens.cacheRead;
  const fileSeat = side.seats?.seats.find((x) => x.seat === s.seat);
  const cost: SeatStats["cost"] =
    !llm || !hasCalls || !costs
      ? null
      : {
          nanoUsd: s.costNanoUsd,
          perWakeNanoUsd: s.wakes === 0 ? null : Math.floor(s.costNanoUsd / s.wakes),
          preflightNanoUsd: s.preflightNanoUsd,
          feesNanoUsd: s.feesNanoUsd,
          reportedNanoUsd: s.reportedLines === 0 ? null : s.reportedNanoUsd,
          estimatedNanoUsd: s.estimatedNanoUsd,
          byKind: side.costByKind?.get(s.seat) ?? null,
          tokens: { ...s.tokens },
          cacheReadPermille: permille(s.tokens.cacheRead, prompt) ?? 0,
          priceCards: [...s.priceCards].toSorted(byText),
          capNanoUsd: fileSeat?.kind === "llm" ? fileSeat.capNanoUsd : s.capNanoUsd,
        };
  return {
    seat: s.seat,
    kind: who.kind,
    label: who.label,
    key: who.key,
    id: who.id,
    name: who.name,
    model: who.model,
    profile: who.profile,
    promptVariant: who.variant,
    reminders: who.reminders,
    toolsHash: who.toolsHash,
    fake: who.fake,
    outcome: {
      rank: p?.rank ?? 1,
      score: p?.score ?? 0,
      cities: p?.cities ?? 0,
      alive: p?.alive ?? false,
      eliminatedAt: p?.eliminatedAt ?? null,
      winner: winners.includes(s.seat),
    },
    play: {
      turns: s.turns,
      wakes: s.wakes,
      rounds: s.rounds,
      calls: s.calls,
      accepted: s.accepted,
      rejections: record(s.rejections),
      thoughts: s.thoughts,
      endings: record(s.endings),
    },
    diplomacy: {
      messagesSent: s.messagesSent,
      messagesReceived: s.messagesReceived,
      publicSent: s.publicSent,
      proposalsSent: s.proposalsSent,
      proposalsReceived: s.proposalsReceived,
      accepted: s.accepted2,
      refused: s.refused,
      alliancesFounded: s.alliancesFounded,
      alliancesJoined: s.alliancesJoined,
      alliancesLeft: s.alliancesLeft,
      pactsSigned: s.pactsSigned,
      pactsKept: s.pactsKept,
      pactsBroken: s.pactsBroken,
      pactEnds: record(s.pactEnds),
      betrayalsCommitted: s.betrayalsCommitted,
      betrayalsSuffered: s.betrayalsSuffered,
      sameModel: llm ? { ...s.same } : null,
      crossModel: llm ? { ...s.cross } : null,
      selfIdentification: s.selfIdentification,
    },
    military: {
      battlesAttacked: s.battlesAttacked,
      battlesDefended: s.battlesDefended,
      battlesWon: s.battlesWon,
      citiesConquered: s.citiesConquered,
      citiesLost: s.citiesLost,
      citiesFounded: s.citiesFounded,
    },
    incidents: {
      handoff:
        s.handoff === null
          ? null
          : { t: s.handoff.t, reason: s.handoffReason, label: s.handoff.label },
      wakeCaps: s.wakeCaps,
      promptCaps: s.promptCaps,
      fallbackPermille: permille(s.fallbacks, s.attempts) ?? 0,
      errorWakes: s.errorWakes,
      refusals: record(s.refusals),
      parallelPermille: llm && hasCalls ? permille(s.parallelRounds, s.toolRounds) : null,
    },
    operations,
    cost,
  };
}
