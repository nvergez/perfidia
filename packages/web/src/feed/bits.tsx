import type { CityEnt } from "@perfidia/protocol/spectator";
import { PlayerGlyph } from "../common/player-glyph.tsx";
import { cn } from "../lib/cn.ts";
import { isCityId } from "../lib/ids.ts";
import { fmtInt } from "../lib/format.ts";
import { fmtSpan } from "../lib/time.ts";
import { useMatch, useSeat } from "../store/hooks.ts";

// Small inline pieces of the feed's sentences: a player named in running text ("Achilles · p2",
// with its glyph; the id always shown), a city ("Sparta · c18", or the id alone when the city keeps
// its id as its name), and a unit list through the skin ("120 hoplites, 30 peltasts").

/** A player in a sentence: glyph, name and id, never truncated mid-sentence. */
export function Who({
  id,
  paren = false,
  className,
}: {
  readonly id: string;
  /** In parentheses, kept on one line with them. */
  readonly paren?: boolean;
  readonly className?: string;
}) {
  const seat = useSeat(id);
  return (
    <span className={cn("whitespace-nowrap", className)}>
      {paren ? "(" : null}
      <PlayerGlyph color={seat?.color ?? null} size={10} className="mr-1" />
      {seat === null ? null : (
        <>
          <bdi className="font-medium">{seat.name}</bdi>
          <span className="text-muted-foreground"> · </span>
        </>
      )}
      <span className="text-muted-foreground font-mono text-[0.92em]">{id}</span>
      {paren ? ")" : null}
    </span>
  );
}

/** Players in prose: "a", "a and b", "a, b and c". */
export function WhoList({ ids }: { readonly ids: readonly string[] }) {
  return (
    <>
      {ids.map((id, i) => (
        <span key={id}>
          {i === 0 ? null : i === ids.length - 1 ? " and " : ", "}
          <Who id={id} />
        </span>
      ))}
    </>
  );
}

const cityName = (c: CityEnt | undefined): string | null =>
  c === undefined || c.name === c.id ? null : c.name;

/** A city: its name (player-authored, isolated) and id, or the id alone. */
export function CityRef({ id }: { readonly id: string }) {
  const name = useMatch((s) => (isCityId(id) ? cityName(s.frame?.cities[id]) : null));
  return (
    <span className="whitespace-nowrap">
      {name === null ? null : (
        <>
          <bdi>{name}</bdi>
          <span className="text-muted-foreground"> · </span>
        </>
      )}
      <span className="font-mono text-[0.92em]">{id}</span>
    </span>
  );
}

/**
 * " (in 3 h 20 min)" while game time `at` is ahead of the playhead, nothing after (nor once the
 * match has ended: what was under way then never lands): subscribed at the game minute, so a card
 * re-renders only while its countdown runs.
 */
export function TimeLeft({ at, className }: { readonly at: number; readonly className?: string }) {
  const left = useMatch((s) =>
    s.playhead >= at || (s.frame?.result ?? null) !== null
      ? 0
      : Math.max(60, Math.floor((at - s.playhead) / 60) * 60),
  );
  if (left <= 0) return null;
  return <span className={cn("text-muted-foreground", className)}> (in {fmtSpan(left)})</span>;
}

/** Unit counts in words through the skin, in its display order. */
export function unitsText(
  units: Readonly<Record<string, number | undefined>>,
  label: (id: string) => { readonly name: string; readonly plural: string },
  order: readonly string[],
): string {
  const ids = Object.keys(units).toSorted((a, b) => {
    const ia = order.indexOf(a);
    const ib = order.indexOf(b);
    return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib) || (a < b ? -1 : a > b ? 1 : 0);
  });
  const parts: string[] = [];
  for (const id of ids) {
    const n = units[id] ?? 0;
    if (n <= 0) continue;
    const l = label(id);
    parts.push(`${fmtInt(n)} ${(n === 1 ? l.name : l.plural).toLowerCase()}`);
  }
  return parts.join(", ");
}
