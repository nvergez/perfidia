import { HOUR } from "@perfidia/engine/core";
import {
  ReportIdSchema,
  STANDARD_EVENT_DATA,
  type AllianceId,
  type CityId,
  type DomainEvent,
  type FeedItem,
  type GameTime,
  type JsonObject,
  type MomentContext,
  type PlayerId,
  type ReportDetail,
  type ReportId,
  type z,
  type ZodType,
} from "@perfidia/protocol";
import { cleanObject, cleanText } from "../clean.ts";
import type { RulesetEvents } from "./rulesets.ts";

// Feed items from `ev` lines (phase-3 design §2.7): one typed item per event that tells the story
// (messages, proposals, diplomacy, betrayals, battles, sieges, conquests, foundings, spying,
// eliminations, countdowns, other rulesets' public events), with the players it involves and an
// importance from 0 to 3. Battle reports are gathered into their battle's item (every copy), and a
// battle knows from the engine's events of the same second, up to the next battle at the same city,
// whether it started or broke a siege or the city fell. A betrayal carries its context: the betrayer's last private messages to the
// victim and its last public thoughts naming the victim within 48 game hours, and when the broken
// relation began. Everything reads the past only, so the steps stay append-only.

/** A feed item before its id (`"<seq>:<i>"`) is known. */
export type FeedDraft = FeedItem extends infer I
  ? I extends FeedItem
    ? Omit<I, "id">
    : never
  : never;

/** How far back a betrayal's context looks. */
export const CONTEXT_WINDOW = 48 * HOUR;
/** Messages and thoughts a context keeps. */
export const CONTEXT_ITEMS = 3;

interface SentMessage {
  readonly item: string;
  readonly t: GameTime;
  readonly to: readonly PlayerId[] | "all";
  readonly text: string;
}

interface Thought {
  readonly turn: number;
  readonly t: GameTime;
  readonly text: string;
}

/** What the mapping reads of the match besides the event. */
export interface FeedEnv {
  /** The owner and tag of a city now. */
  city(city: string): { readonly owner: PlayerId | null; readonly tag: string | null } | null;
  /** The sender's turn of a message: its last act line in the same second. */
  turnOf(seat: PlayerId, t: GameTime): number | null;
}

const isPlayer = (p: string): p is PlayerId => /^p[1-9][0-9]*$/.test(p);
const isCity = (c: string): c is CityId => /^c[1-9][0-9]*$/.test(c);
const isAlliance = (a: string): a is AllianceId => /^a[1-9][0-9]*$/.test(a);
const isReport = (r: string): r is ReportId => ReportIdSchema.safeParse(r).success;

type DiplomacyEvent = Extract<FeedItem, { k: "diplomacy" }>["event"];
const pairKey = (kind: "ally" | "pact", a: string, b: string): string =>
  a < b ? `${kind}|${a}|${b}` : `${kind}|${b}|${a}`;
const uniq = (list: readonly PlayerId[]): PlayerId[] => [...new Set(list)];

/** The event's data as its standard schema reads it, or null when it does not. */
function data<S extends ZodType>(schema: S, e: DomainEvent): z.output<S> | null {
  const parsed = schema.safeParse(e.data);
  return parsed.success ? parsed.data : null;
}

/** ASCII letters lowered, nothing else (no Unicode tables). */
const asciiLower = (s: string): string =>
  s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));

/** Does `text` name `word` as a whole word (ASCII letters and digits around it), ignoring ASCII case? */
function names(text: string, word: string): boolean {
  const hay = asciiLower(text);
  const needle = asciiLower(word);
  let at = hay.indexOf(needle);
  while (at >= 0) {
    const before = at === 0 ? "" : (hay[at - 1] ?? "");
    const after = hay[at + needle.length] ?? "";
    if (!/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after)) return true;
    at = hay.indexOf(needle, at + 1);
  }
  return false;
}

/** The feed's memory of the match: what items and contexts need from earlier lines. */
export class FeedState {
  private readonly events: RulesetEvents;
  /** The profile id each seat's LLM label names (thoughts that name it name the seat). */
  private readonly profiles = new Map<PlayerId, string>();
  /** Battle report copies of the current second, by city. */
  private reportsAt: { t: GameTime; byCity: Map<string, ReportId[]> } = {
    t: -1,
    byCity: new Map(),
  };
  private battles = 0;
  /** When each relation (`ally|pA|pB`, `pact|pA|pB`) last began. */
  private readonly since = new Map<string, GameTime>();
  /** Each alliance's members, from its events (a dissolved one keeps its last members). */
  private readonly members = new Map<string, PlayerId[]>();
  private readonly sent = new Map<PlayerId, SentMessage[]>();
  private readonly thoughts = new Map<PlayerId, Thought[]>();
  /** Every report copy, by id. */
  readonly reports = new Map<ReportId, ReportDetail>();

  constructor(events: RulesetEvents) {
    this.events = events;
  }

  /** A seat's controller label: an LLM label names its profile (`llm:…:odysseus@1:p2`). */
  controller(seat: PlayerId, label: string): void {
    const m = /^llm:[^:]*:([a-z][a-z0-9-]*)@[0-9]+:/.exec(label);
    if (m?.[1] !== undefined) this.profiles.set(seat, m[1]);
  }

  /** A message item with its id, for later contexts. */
  noteMessage(item: Extract<FeedItem, { k: "message" }>): void {
    if (!item.private) return;
    push(this.sent, item.from, { item: item.id, t: item.t, to: item.to, text: item.text }, item.t);
  }

  /** A public thought, for later contexts. */
  noteThought(seat: PlayerId, turn: number, t: GameTime, text: string): void {
    push(this.thoughts, seat, { turn, t, text }, t);
  }

  /** What `by` told `against` and thought of it before `t`, and when their `kind` relation began. */
  context(by: PlayerId, against: PlayerId, kind: "ally" | "pact", t: GameTime): MomentContext {
    const from = t - CONTEXT_WINDOW;
    const messages = (this.sent.get(by) ?? [])
      .filter((m) => m.t >= from && m.to !== "all" && m.to.includes(against))
      .slice(-CONTEXT_ITEMS)
      .map((m) => ({ item: m.item, t: m.t, text: m.text }));
    const words = [against, this.profiles.get(against)].filter((w) => w !== undefined);
    const thoughts = (this.thoughts.get(by) ?? [])
      .filter((x) => x.t >= from && words.some((w) => names(x.text, w)))
      .slice(-CONTEXT_ITEMS)
      .map((x) => ({ turn: x.turn, t: x.t, text: x.text }));
    return { messages, thoughts, since: this.since.get(pairKey(kind, by, against)) ?? null };
  }

  /**
   * The items of one event. `ahead` holds the engine's events of the same step that later `ev`
   * lines will carry (a battle reads its siege and conquest from them); `seq` names the report copies.
   */
  event(e: DomainEvent, env: FeedEnv, ahead: readonly DomainEvent[], seq: number): FeedDraft[] {
    const t = e.t;
    if (this.reportsAt.t !== t) this.reportsAt = { t, byCity: new Map() };
    const siege = this.events.siege(e);
    if (siege !== null) {
      if (!isCity(siege.city)) return [];
      return [
        {
          k: "siege",
          t,
          players: uniq([siege.by, ...(siege.owner === null ? [] : [siege.owner])]),
          importance: 2,
          event: siege.event,
          city: siege.city,
          owner: siege.owner,
          by: siege.by,
          endsAt: siege.endsAt,
          cause: siege.cause,
        },
      ];
    }
    const countdown = this.events.countdown(e);
    if (countdown !== null) {
      return [
        {
          k: "countdown",
          t,
          players: countdown.members,
          importance: countdown.event === "started" ? 3 : 2,
          ...countdown,
          key: cleanText(countdown.key),
        },
      ];
    }
    switch (e.type) {
      case "message": {
        const d = data(STANDARD_EVENT_DATA.message, e);
        if (d === null) return [];
        return [
          {
            k: "message",
            t,
            players: uniq([d.from, ...(d.to === "all" ? [] : d.to)]),
            importance: 1,
            message: d.message,
            from: d.from,
            to: d.to === "all" ? "all" : [...d.to],
            private: d.to !== "all",
            text: cleanText(d.text),
            turn: env.turnOf(d.from, t),
          },
        ];
      }
      case "proposal": {
        const d = data(STANDARD_EVENT_DATA.proposal, e);
        if (d === null) return [];
        return [
          {
            k: "proposal",
            t,
            players: uniq([d.from, d.to]),
            importance: 1,
            proposal: d.proposal,
            from: d.from,
            to: d.to,
            kind: d.kind,
            name: d.name === null ? null : cleanText(d.name),
            text: cleanText(d.text),
            until: d.until,
            expiresAt: d.expiresAt,
          },
        ];
      }
      case "proposal_answered": {
        const d = data(STANDARD_EVENT_DATA.proposal_answered, e);
        if (d === null) return [];
        const base = { proposal: d.proposal, from: d.from, to: d.to, kind: d.kind };
        return [
          {
            k: "answer",
            t,
            players: uniq([d.from, d.to]),
            importance: 1,
            ...base,
            accept: d.accept,
          },
        ];
      }
      case "proposal_expired": {
        const d = data(STANDARD_EVENT_DATA.proposal_expired, e);
        if (d === null) return [];
        return [
          {
            k: "expired",
            t,
            players: uniq([d.from, d.to]),
            importance: 1,
            proposal: d.proposal,
            from: d.from,
            to: d.to,
            kind: d.kind,
          },
        ];
      }
      case "alliance_formed": {
        const d = data(STANDARD_EVENT_DATA.alliance_formed, e);
        if (d === null) return [];
        for (const a of d.members)
          for (const b of d.members) if (a < b) this.began("ally", a, b, t);
        this.members.set(d.alliance, [...d.members]);
        return [
          this.diplomacy("alliance_formed", t, d.members, {
            alliance: d.alliance,
            name: cleanText(d.name),
          }),
        ];
      }
      case "alliance_joined": {
        const d = data(STANDARD_EVENT_DATA.alliance_joined, e);
        if (d === null) return [];
        const members = uniq([...(this.members.get(d.alliance) ?? []), d.player]);
        this.members.set(d.alliance, members);
        for (const m of members) if (m !== d.player) this.began("ally", d.player, m, t);
        return [this.diplomacy("alliance_joined", t, members, { alliance: d.alliance })];
      }
      case "alliance_left": {
        const d = data(STANDARD_EVENT_DATA.alliance_left, e);
        if (d === null) return [];
        const before = this.members.get(d.alliance) ?? [];
        const members = uniq([d.player, ...before]);
        this.members.set(
          d.alliance,
          before.filter((p) => p !== d.player),
        );
        return [
          this.diplomacy("alliance_left", t, members, { alliance: d.alliance, cause: d.cause }),
        ];
      }
      case "alliance_dissolved": {
        const d = data(STANDARD_EVENT_DATA.alliance_dissolved, e);
        if (d === null) return [];
        return [
          this.diplomacy("alliance_dissolved", t, this.members.get(d.alliance) ?? [], {
            alliance: d.alliance,
          }),
        ];
      }
      case "pact_signed":
      case "pact_renewed": {
        const d = data(STANDARD_EVENT_DATA[e.type], e);
        if (d === null) return [];
        if (e.type === "pact_signed") this.began("pact", d.a, d.b, t);
        return [this.diplomacy(e.type, t, [d.a, d.b], { expiresAt: d.expiresAt })];
      }
      case "pact_ended": {
        const d = data(STANDARD_EVENT_DATA.pact_ended, e);
        if (d === null) return [];
        return [this.diplomacy("pact_ended", t, [d.a, d.b], { cause: d.cause })];
      }
      case "pact_expired": {
        const d = data(STANDARD_EVENT_DATA.pact_expired, e);
        if (d === null) return [];
        return [this.diplomacy("pact_expired", t, [d.a, d.b], {})];
      }
      case "betrayal": {
        const d = data(STANDARD_EVENT_DATA.betrayal, e);
        if (d === null) return [];
        return [
          {
            k: "betrayal",
            t,
            players: uniq([d.by, d.against]),
            importance: 3,
            by: d.by,
            against: d.against,
            relation: d.relation,
            city: d.city,
            context: this.context(d.by, d.against, d.relation, t),
          },
        ];
      }
      case "battle_report": {
        const d = data(STANDARD_EVENT_DATA.battle_report, e);
        if (d === null) return [];
        const list = this.reportsAt.byCity.get(d.city) ?? [];
        list.push(d.report);
        this.reportsAt.byCity.set(d.city, list);
        this.report(d.report, seq, e, d.city);
        return [];
      }
      case "battle": {
        const d = data(STANDARD_EVENT_DATA.battle, e);
        if (d === null) return [];
        const reports = this.reportsAt.byCity.get(d.city) ?? [];
        this.reportsAt.byCity.delete(d.city);
        for (const r of reports) {
          const detail = this.reports.get(r);
          if (detail !== undefined) {
            this.reports.set(r, { ...detail, copies: reports.filter((x) => x !== r) });
          }
        }
        // What this battle caused: the siege and conquest events of its city that follow it in the
        // same second, up to the next battle there (several waves can land in one second).
        let besieged: "started" | "broken" | null = null;
        let fell = false;
        for (const next of ahead) {
          if (next.t !== t) continue;
          if (next.type === "battle" && data(STANDARD_EVENT_DATA.battle, next)?.city === d.city) {
            break;
          }
          const s = this.events.siege(next);
          if (s !== null && s.city === d.city) besieged = s.event;
          if (next.type === "city_conquered" && next.data["city"] === d.city) fell = true;
        }
        this.battles += 1;
        const defender = d.defender === "neutral" ? [] : [d.defender];
        return [
          {
            k: "battle",
            t,
            players: uniq([d.attacker, ...defender]),
            importance: besieged !== null || fell || this.battles === 1 ? 2 : 1,
            city: d.city,
            attacker: d.attacker,
            defender: d.defender,
            kind: d.kind,
            winner: d.winner,
            reports,
            siege: besieged,
            fell,
          },
        ];
      }
      case "city_conquered": {
        const d = data(STANDARD_EVENT_DATA.city_conquered, e);
        if (d === null) return [];
        return [
          {
            k: "conquest",
            t,
            players: uniq([d.to, ...(d.from === null ? [] : [d.from])]),
            importance: 3,
            city: d.city,
            from: d.from,
            to: d.to,
            prize: this.events.prize(env.city(d.city)?.tag ?? null),
          },
        ];
      }
      case "city_founded": {
        const d = data(STANDARD_EVENT_DATA.city_founded, e);
        if (d === null) return [];
        return [
          {
            k: "founding",
            t,
            players: [d.owner],
            importance: 0,
            city: d.city,
            island: d.island,
            slot: d.slot,
            owner: d.owner,
          },
        ];
      }
      case "spy_report":
      case "spy_failed":
      case "spy_detected": {
        const city = e.data["city"];
        if (typeof city !== "string" || !isCity(city)) return [];
        const spier = e.type === "spy_detected" ? e.data["by"] : e.to[0]?.p;
        const by = typeof spier === "string" && isPlayer(spier) ? spier : null;
        const report = e.type === "spy_report" ? e.data["report"] : null;
        const reportId = typeof report === "string" && isReport(report) ? report : null;
        if (reportId !== null) this.report(reportId, seq, e, city);
        const owner = env.city(city)?.owner ?? null;
        return [
          {
            k: "spy",
            t,
            players: uniq([...(by === null ? [] : [by]), ...(owner === null ? [] : [owner])]),
            importance: 0,
            event: e.type,
            city,
            by,
            report: reportId,
          },
        ];
      }
      case "player_eliminated": {
        const d = data(STANDARD_EVENT_DATA.player_eliminated, e);
        if (d === null) return [];
        return [{ k: "elimination", t, players: [d.player], importance: 3, player: d.player }];
      }
      default:
        break;
    }
    if (isStandard(e.type) || this.events.hidden(e.type) || !e.public) return [];
    return [
      {
        k: "event",
        t,
        players: uniq(e.to.map((r) => r.p)),
        importance: 1,
        type: e.type,
        data: cleanObject(e.data),
      },
    ];
  }

  private began(kind: "ally" | "pact", a: PlayerId, b: PlayerId, t: GameTime): void {
    this.since.set(pairKey(kind, a, b), t);
  }

  private report(report: ReportId, seq: number, e: DomainEvent, city: CityId): void {
    const recipient = e.to[0]?.p ?? null;
    this.reports.set(report, {
      report,
      seq,
      t: e.t,
      type: e.type,
      city,
      recipient,
      data: cleanObject(e.data),
      copies: [],
    });
  }

  private diplomacy(
    event: DiplomacyEvent,
    t: GameTime,
    players: readonly PlayerId[],
    o: {
      readonly alliance?: string;
      readonly name?: string;
      readonly cause?: "left" | "betrayal" | "eliminated" | "superseded";
      readonly expiresAt?: GameTime | null;
    },
  ): FeedDraft {
    const alliance = event.startsWith("alliance_");
    const importance = o.cause === "betrayal" ? 3 : alliance ? 2 : 1;
    return {
      k: "diplomacy",
      t,
      players: uniq(players),
      importance,
      event,
      alliance: o.alliance !== undefined && isAlliance(o.alliance) ? o.alliance : null,
      name: o.name ?? null,
      cause: o.cause ?? null,
      expiresAt: o.expiresAt ?? null,
    };
  }
}

const STANDARD: ReadonlySet<string> = new Set(Object.keys(STANDARD_EVENT_DATA));
const isStandard = (type: string): boolean => STANDARD.has(type);

function push<T extends { readonly t: GameTime }>(
  map: Map<PlayerId, T[]>,
  seat: PlayerId,
  entry: T,
  now: GameTime,
): void {
  const list = (map.get(seat) ?? []).filter((x) => x.t >= now - CONTEXT_WINDOW);
  list.push(entry);
  map.set(seat, list);
}

/** The JSON object of a ruleset event's data, cleaned (for `event` items and reports). */
export function eventData(e: DomainEvent): JsonObject {
  return cleanObject(e.data);
}
