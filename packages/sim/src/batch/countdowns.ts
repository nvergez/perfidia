import {
  PlayerIdSchema,
  STANDARD_EVENT_DATA,
  z,
  type GameTime,
  type LogLine,
  type PlayerId,
} from "@perfidia/protocol";
import { DOMINATION_STARTED } from "./fights.ts";

// Domination countdowns (docs/architecture.md §12.2, perfidia-1 §13.3), from the public
// `domination_started` and `domination_cancelled` events and the end line: each countdown's bloc,
// its cities at the start split into the ones its members took by conquest, the ones they founded
// and the rest (their starting cities), from the `city_conquered` and `city_founded` events so
// far (from perfidia-1@1.1.0 the event also gives the bloc's taken cities and the taken cities
// the threshold asks for, §13.3); and how it ended: won (the match ended by domination at its `endsAt` with its members as
// the winners), cancelled (with the log's reason and the same-second events that explain it:
// members leaving, joining, eliminated, betraying, or losing cities) or still open at the end.

export const DOMINATION_CANCELLED = "domination_cancelled";

export interface CountdownRow {
  readonly t: GameTime;
  /** The bloc key: an alliance id, or a lone player's id. */
  readonly key: string;
  readonly members: PlayerId[];
  /** The members' controllers without `bot:`, in member order. */
  readonly bots: string[];
  /** The bloc's cities at the start, as the event counts them, and the threshold it met. */
  readonly cities: number;
  readonly threshold: number | null;
  /** perfidia-1@1.1.0: the bloc's taken cities at the start, and the taken cities it needed. */
  readonly taken?: number;
  readonly needTaken?: number;
  readonly endsAt: GameTime | null;
  /** Of `cities`: held by a member that took it by conquest, or founded it. */
  readonly conquered: number;
  readonly founded: number;
  /** `cities − conquered − founded`: the members' starting cities. */
  readonly initial: number;
  readonly outcome: "won" | "cancelled" | "open";
  /** When it was won or cancelled; null while open. */
  readonly endedAt: GameTime | null;
  /** The cancellation reason the log gives (perfidia-1: `condition`, `membership`). */
  readonly reason: string | null;
  /** Same-second events behind a cancellation, e.g. `p2 left a1 (betrayal)`, `c12 lost to p5`. */
  readonly detail: string[];
}

const StartedSchema = z.looseObject({
  key: z.string(),
  members: z.array(PlayerIdSchema).min(1),
  cities: z.int().nonnegative(),
  threshold: z.int().nonnegative().optional(),
  taken: z.int().nonnegative().optional(),
  needTaken: z.int().nonnegative().optional(),
  endsAt: z.int().nonnegative().optional(),
});
const CancelledSchema = z.looseObject({ key: z.string(), reason: z.string().optional() });

type Draft = { -readonly [K in keyof CountdownRow]: CountdownRow[K] };

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** What the same-second event `line` says about a cancelled countdown, or null. */
function explain(line: LogLine, c: CountdownRow): string | null {
  if (line.k !== "ev") return null;
  const { type, data } = line.e;
  const member = (p: string): boolean => c.members.some((m) => m === p);
  if (type === "alliance_left") {
    const d = STANDARD_EVENT_DATA.alliance_left.safeParse(data);
    if (d.success && member(d.data.player)) {
      return `${d.data.player} left ${d.data.alliance}${d.data.cause === "left" ? "" : ` (${d.data.cause})`}`;
    }
  } else if (type === "alliance_joined") {
    const d = STANDARD_EVENT_DATA.alliance_joined.safeParse(data);
    if (d.success && d.data.alliance === c.key) return `${d.data.player} joined ${d.data.alliance}`;
  } else if (type === "player_eliminated") {
    const d = STANDARD_EVENT_DATA.player_eliminated.safeParse(data);
    if (d.success && member(d.data.player)) return `${d.data.player} eliminated`;
  } else if (type === "betrayal") {
    const d = STANDARD_EVENT_DATA.betrayal.safeParse(data);
    if (d.success && member(d.data.by)) return `${d.data.by} betrayed ${d.data.against}`;
  } else if (type === "city_conquered") {
    const d = STANDARD_EVENT_DATA.city_conquered.safeParse(data);
    if (d.success && d.data.from !== null && member(d.data.from)) {
      return `${d.data.city} lost to ${d.data.to}`;
    }
  }
  return null;
}

/**
 * Every domination countdown of a log, in start order. `bots` names each seat's controller
 * (without `bot:`); a member it does not name is `?`.
 */
export function countdownRows(
  lines: readonly LogLine[],
  bots: Readonly<Record<string, string>>,
): CountdownRow[] {
  const out: Draft[] = [];
  const open = new Map<string, Draft>();
  // How each city's current owner got it; a city absent is still with its starting owner.
  const holder = new Map<string, { owner: PlayerId; how: "conquered" | "founded" }>();
  let end: { t: GameTime; reason: string; winners: readonly PlayerId[] } | null = null;
  for (const line of lines) {
    if (line.k === "end") {
      end = { t: line.result.endedAt, reason: line.result.reason, winners: line.result.winners };
      continue;
    }
    if (line.k !== "ev") continue;
    const { type, data } = line.e;
    if (type === "city_founded") {
      const d = STANDARD_EVENT_DATA.city_founded.safeParse(data);
      if (d.success) holder.set(d.data.city, { owner: d.data.owner, how: "founded" });
    } else if (type === "city_conquered") {
      const d = STANDARD_EVENT_DATA.city_conquered.safeParse(data);
      if (d.success) holder.set(d.data.city, { owner: d.data.to, how: "conquered" });
    } else if (type === DOMINATION_STARTED) {
      const d = StartedSchema.safeParse(data);
      if (!d.success) continue;
      const members = d.data.members;
      let conquered = 0;
      let founded = 0;
      for (const h of holder.values()) {
        if (!members.includes(h.owner)) continue;
        if (h.how === "conquered") conquered += 1;
        else founded += 1;
      }
      const row: Draft = {
        t: line.t,
        key: d.data.key,
        members: [...members],
        bots: members.map((m) => bots[m] ?? "?"),
        cities: d.data.cities,
        threshold: d.data.threshold ?? null,
        endsAt: d.data.endsAt ?? null,
        conquered,
        founded,
        initial: Math.max(0, d.data.cities - conquered - founded),
        outcome: "open",
        endedAt: null,
        reason: null,
        detail: [],
      };
      if (d.data.taken !== undefined) row.taken = d.data.taken;
      if (d.data.needTaken !== undefined) row.needTaken = d.data.needTaken;
      out.push(row);
      open.set(row.key, row);
    } else if (type === DOMINATION_CANCELLED) {
      const d = CancelledSchema.safeParse(data);
      const row = d.success ? open.get(d.data.key) : undefined;
      if (!d.success || row === undefined) continue;
      open.delete(d.data.key);
      row.outcome = "cancelled";
      row.endedAt = line.t;
      row.reason = d.data.reason ?? null;
    }
  }
  if (end?.reason === "domination") {
    const winners = end.winners.toSorted(byCodeUnit);
    for (const row of open.values()) {
      const members = row.members.toSorted(byCodeUnit);
      const same = members.length === winners.length && members.every((m, i) => m === winners[i]);
      if (same && row.endsAt === end.t) {
        row.outcome = "won";
        row.endedAt = end.t;
      }
    }
  }
  const cancelled = out.filter((r) => r.outcome === "cancelled");
  if (cancelled.length > 0) {
    const seconds = new Set(cancelled.map((r) => r.endedAt));
    const bySecond = new Map<GameTime, LogLine[]>();
    for (const line of lines) {
      if (line.k !== "ev" || !seconds.has(line.t)) continue;
      const list = bySecond.get(line.t) ?? [];
      list.push(line);
      bySecond.set(line.t, list);
    }
    for (const row of cancelled) {
      for (const line of bySecond.get(row.endedAt ?? -1) ?? []) {
        const why = explain(line, row);
        if (why !== null) row.detail.push(why);
      }
    }
  }
  return out;
}
