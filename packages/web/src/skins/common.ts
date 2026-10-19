import type { CityEnt, MatchMeta, PlayerEnt } from "@perfidia/protocol/spectator";
import { isPlayerId, type PlayerId } from "../lib/ids.ts";
import { arrOf, field, isRecord, numOf, strOf, strsOf, timeOf } from "../lib/json.ts";
import { DAY, fmtTime } from "../lib/time.ts";
import type {
  CityExtView,
  Label,
  PlayerExtView,
  ReportRow,
  ReportStack,
  ReportView,
  SkinIcon,
} from "./types.ts";

// Pieces every skin shares: a label from an id, `ext` readers, the end of the match in words, and a
// generic battle report.

/** `some_id` → "Some id". */
export function humanize(id: string): string {
  const s = id.replaceAll(/[_-]+/g, " ").trim();
  return s.length === 0 ? id : `${s.charAt(0).toUpperCase()}${s.slice(1)}`;
}

export function label(name: string, icon: SkinIcon = "circle", plural?: string): Label {
  return { name, plural: plural ?? `${name}s`, icon };
}

export function rawLabel(id: string): Label {
  return label(humanize(id));
}

export function playerIds(v: unknown): PlayerId[] {
  return strsOf(v).filter(isPlayerId);
}

/** City extras most rulesets share: points, taken, former owners, a siege. */
export function genericCity(c: CityEnt, prize: boolean): CityExtView {
  const siege = field(c.ext, "siege");
  const by = strOf(field(siege, "by"));
  return {
    points: numOf(field(c.ext, "points")),
    prize,
    taken: field(c.ext, "taken") === true,
    former: playerIds(field(c.ext, "former")),
    siege: by !== null && isPlayerId(by) ? { by, endsAt: timeOf(field(siege, "ends")) } : null,
  };
}

export function genericPlayer(p: PlayerEnt): PlayerExtView {
  return { tiebreak: numOf(field(p.ext, "tiebreak")), taken: numOf(field(p.ext, "taken")) };
}

/** The match end from the meta: "the end of day 7". */
export function endOfMatch(meta: MatchMeta): string {
  const days = meta.matchEnd / DAY;
  return Number.isInteger(days) ? `the end of day ${days}` : fmtTime(meta.matchEnd);
}

/** A number from the config at a path (`["time", "dominationHold"]`), else null. */
export function configNumber(meta: MatchMeta, path: readonly string[]): number | null {
  let v: unknown = meta.config;
  for (const k of path) v = field(v, k);
  return numOf(v);
}

function valueText(v: unknown): string {
  if (v === null || v === undefined) return "–";
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return v.map(valueText).join(", ");
  if (isRecord(v)) {
    return Object.entries(v)
      .map(([k, x]) => `${k} ${valueText(x)}`)
      .join(", ");
  }
  return "–";
}

/** Any report as rows of its top-level fields, and the unit stacks when it lists them. */
export function genericReport(
  type: string,
  data: Readonly<Record<string, unknown>>,
  unit: (id: string) => Label,
): ReportView {
  const rows: ReportRow[] = [];
  for (const [k, v] of Object.entries(data)) {
    if (k === "stacks" || k === "report") continue;
    rows.push({ label: humanize(k), value: valueText(v) });
  }
  const stacks: ReportStack[] = [];
  for (const s of arrOf(field(data, "stacks"))) {
    const u = strOf(field(s, "unit"));
    stacks.push({
      owner: strOf(field(s, "owner")) ?? "?",
      side: strOf(field(s, "side")) ?? "",
      unit: u === null ? "?" : unit(u).name,
      before: numOf(field(s, "before")) ?? 0,
      lost: numOf(field(s, "lost")) ?? 0,
      survived: numOf(field(s, "survived")) ?? 0,
    });
  }
  return { title: humanize(type), rows, stacks };
}
