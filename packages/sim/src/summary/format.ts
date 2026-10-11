import { fmtTime } from "@perfidia/engine/core";
import type { ClockSpec } from "@perfidia/protocol";
import type { MatchSummary, WakeDay } from "./summarize.ts";

// The text form of a match summary (docs/architecture.md §12.2), printed by `run` and `summary`.

/** `lockstep`, `realtime 3/1 virtual, latency 2000-60000 ms`, … */
export function clockText(c: ClockSpec): string {
  if (c.kind === "lockstep") return `lockstep (${c.maxTurnsPerSecond} turns/s per seat)`;
  const speed = c.speed[1] === 1 ? `${c.speed[0]}×` : `${c.speed[0]}/${c.speed[1]}×`;
  const latency =
    c.latencyMs === undefined ? "" : `, latency ${c.latencyMs[0]}-${c.latencyMs[1]} ms`;
  return `realtime ${speed} on the ${c.time} clock${latency}`;
}

/** Fixed-width table rows: each column padded to its widest cell (numbers right-aligned). */
export function table(rows: readonly (readonly string[])[], right: ReadonlySet<number>): string[] {
  const widths: number[] = [];
  for (const row of rows) {
    for (const [i, cell] of row.entries()) widths[i] = Math.max(widths[i] ?? 0, cell.length);
  }
  return rows.map((row) =>
    row
      .map((cell, i) =>
        right.has(i) ? cell.padStart(widths[i] ?? 0) : cell.padEnd(widths[i] ?? 0),
      )
      .join("  ")
      .trimEnd(),
  );
}

function counts(rec: Readonly<Record<string, number>>): string {
  const parts = Object.entries(rec).map(([k, v]) => `${k} ${v}`);
  return parts.length === 0 ? "none" : parts.join(", ");
}

function wakeCell(d: WakeDay): string {
  return `${d.urgent}/${d.own}/${d.social}/${d.safety}/${d.start}${d.deferred > 0 ? ` +${d.deferred}d` : ""}`;
}

function bytesText(n: number): string {
  if (n < 10_000) return `${n} B`;
  if (n < 10_000_000) return `${Math.round(n / 1000)} kB`;
  return `${(n / 1_000_000).toFixed(1)} MB`;
}

/** The summary as text (§12.2). */
export function formatSummary(s: MatchSummary): string {
  const out: string[] = [];
  out.push(`${s.ruleset} · seed ${s.seed} · ${s.players} seats · ${clockText(s.clock)}`);
  if (s.status === "ended" && s.endedAt !== null) {
    const winners =
      s.winners.length === 0
        ? "none"
        : s.winners
            .map((w) => `${w} (${s.seats.find((x) => x.seat === w)?.controller ?? "?"})`)
            .join(", ");
    out.push(
      `ended at ${fmtTime(s.endedAt)} after ${s.endDay ?? 0} game day(s) · reason ${s.reason ?? "?"} · winners ${winners}`,
    );
  } else if (s.status === "fatal" && s.fatal !== null) {
    out.push(`FATAL at ${fmtTime(s.fatal.t)} (${s.fatal.kind}): ${s.fatal.message}`);
  } else {
    out.push(`incomplete: the log stops at ${fmtTime(s.lastT)} with no end line`);
  }

  out.push("", "standings:");
  const ranked = s.seats.toSorted(
    (a, b) => (a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER),
  );
  out.push(
    ...table(
      [
        ["rank", "seat", "score", "cities", "alive", "turns", "calls", "controller"],
        ...ranked.map((x) => [
          x.rank === null ? "-" : String(x.rank),
          x.seat,
          x.score === null ? "-" : String(x.score),
          x.cities === null ? "-" : String(x.cities),
          x.alive === null ? "-" : x.alive ? "yes" : `no (${fmtTime(x.eliminatedAt ?? 0)})`,
          String(x.turns),
          String(x.calls),
          x.controller,
        ]),
      ],
      new Set([0, 2, 3, 5, 6]),
    ).map((l) => `  ${l}`),
  );

  const e = s.events;
  out.push(
    "",
    `events: battles ${e.battles} · conquests ${e.conquests} · foundings ${e.foundings} · eliminations ${e.eliminations}`,
    `        sieges started ${e.siegesStarted} / held ${e.siegesHeld} / broken ${e.siegesBroken}`,
    `        alliances formed ${e.alliancesFormed} / joined ${e.alliancesJoined} / left ${e.alliancesLeft} · pacts signed ${e.pactsSigned} / renewed ${e.pactsRenewed} / ended ${e.pactsEnded} / expired ${e.pactsExpired}`,
    `        betrayals ${e.betrayals} · messages ${e.messages} · proposals ${e.proposals} · spy reports ${e.spyReports}`,
  );

  const w = s.wakes;
  out.push(
    "",
    `wake-ups per seat per day: mean ${w.perSeatPerDay.mean} · max ${w.perSeatPerDay.max} · totals urgent ${w.total.urgent}, own ${w.total.own}, social ${w.total.social}, safety ${w.total.safety}, start ${w.total.start}, deferred ${w.total.deferred}`,
    "  by seat and game day (urgent/own/social/safety/start, +N deferred):",
  );
  const dayHeads = Array.from({ length: w.days }, (_, i) => `D${i + 1}`);
  out.push(
    ...table(
      [["seat", ...dayHeads], ...s.seats.map((x) => [x.seat, ...x.wakes.map(wakeCell)])],
      new Set(),
    ).map((l) => `  ${l}`),
  );

  out.push(
    "",
    `INTERNAL failures: ${s.internal}`,
    `turns ${s.turns} · round trips per wake mean ${s.perWake.rounds.mean}, p95 ${s.perWake.rounds.p95}, max ${s.perWake.rounds.max} · calls per wake mean ${s.perWake.calls.mean}, p95 ${s.perWake.calls.p95}, max ${s.perWake.calls.max}`,
    `rejections by the gateway: ${counts(s.rejections.gateway)}`,
    `rejections by the engine: ${counts(s.rejections.engine)}`,
    `engine events ${s.engineEvents} · ${s.lines} lines · ${bytesText(s.logBytes)}${
      s.wallMs === null
        ? ""
        : ` · wall ${(s.wallMs / 1000).toFixed(2)} s${s.eventsPerSecond === null ? "" : ` · ${s.eventsPerSecond} events/s`}`
    }`,
    "",
  );
  return out.join("\n");
}
