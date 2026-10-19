import type {
  FeedItemOf,
  HourPoint,
  NotebookVersion,
  PlayerDossier,
} from "@perfidia/protocol/spectator";
import { notebookTexts, seatTally } from "@perfidia/spectator/reduce";
import { Loader2, Skull, Swords } from "lucide-react";
import { useId, useMemo, useState, type PointerEvent } from "react";
import { GameTime } from "../common/game-time.tsx";
import { PlainText } from "../common/plain-text.tsx";
import { PlayerLabel } from "../common/player-label.tsx";
import { cn } from "../lib/cn.ts";
import { fmtInt, plural } from "../lib/format.ts";
import type { PlayerId } from "../lib/ids.ts";
import { fmtTime } from "../lib/time.ts";
import { OpenTurnButton } from "../turns/open-turn.tsx";
import { useFeed, useMatch } from "../store/hooks.ts";
import { uiActions } from "../store/ui.ts";
import {
  countUntil,
  diffStats,
  hunksOf,
  layout,
  lineDiff,
  nearest,
  sparkOf,
  type DiffLine,
} from "./record.ts";

// The dossier extras (phase-3 design §4.2 Pass C, C2; docs/phase3.md §16.8), in the dossier sheet's
// chunk (loaded on demand): the seat's record at the playhead (turns played, messages sent and
// received, betrayals committed and suffered, counted over the feed the viewer holds), its score
// and cities hour by hour (sparklines up to the playhead, from the dossier's checkpoints), and its
// notebook as it was at the playhead with the history of its changes (each version against the one
// before, a JSON notebook laid out as Pass B shows it). Nothing after the playhead is shown.

// Record ----------------------------------------------------------------------------------------

function Tile({
  label,
  value,
  icon: Icon,
  alarm = false,
}: {
  readonly label: string;
  readonly value: number;
  readonly icon?: typeof Swords;
  readonly alarm?: boolean;
}) {
  const hot = alarm && value > 0;
  return (
    <div
      className={cn(
        "bg-card flex flex-col justify-between gap-0.5 rounded-md border px-2 py-1.5",
        hot && "border-betrayal/60",
      )}
    >
      <dt className="text-muted-foreground flex items-center gap-1 text-[0.7rem] leading-tight">
        {Icon === undefined ? null : (
          <Icon
            className={cn("size-3 shrink-0", hot ? "text-betrayal" : "opacity-50")}
            aria-hidden="true"
          />
        )}
        {label}
      </dt>
      <dd className="text-lg leading-tight font-semibold tabular-nums">{fmtInt(value)}</dd>
    </div>
  );
}

function BetrayalLine({
  item,
  seat,
}: {
  readonly item: FeedItemOf<"betrayal">;
  readonly seat: PlayerId;
}) {
  const committed = item.by === seat;
  const other = committed ? item.against : item.by;
  const relation = item.relation === "ally" ? "ally" : "pact partner";
  return (
    <li className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs">
      {committed ? (
        <Swords className="text-betrayal size-3 shrink-0" aria-hidden="true" />
      ) : (
        <Skull className="text-betrayal size-3 shrink-0" aria-hidden="true" />
      )}
      <span>
        {committed ? "Attacked its" : "Attacked by its"} {relation}
      </span>
      <button
        type="button"
        title="Open this player's dossier"
        data-player={other}
        onClick={() => uiActions.openPlayer(other)}
        className="min-w-0 rounded hover:underline"
      >
        <PlayerLabel player={other} />
      </button>
      <span className="text-muted-foreground">
        at <span className="font-mono">{item.city}</span>, <GameTime t={item.t} />
      </span>
    </li>
  );
}

/** The seat's record at the playhead, from the feed the viewer holds. */
export function SeatRecord({ seat }: { readonly seat: PlayerId }) {
  const feed = useFeed();
  const complete = useMatch((s) => s.loaded.complete);
  const tally = useMemo(
    () =>
      seatTally(
        feed.map((e) => e.item),
        seat,
      ),
    [feed, seat],
  );
  const betrayals = useMemo(
    () =>
      feed
        .flatMap((e) => (e.item.k === "betrayal" ? [e.item] : []))
        .filter((b) => b.by === seat || b.against === seat),
    [feed, seat],
  );
  return (
    <div className="flex flex-col gap-2" data-testid="seat-record">
      <dl className="grid grid-cols-3 gap-1.5">
        <Tile label="Turns played" value={tally.turns} />
        <Tile label="Messages sent" value={tally.messagesSent} />
        <Tile label="Messages received" value={tally.messagesReceived} />
      </dl>
      <dl className="grid grid-cols-2 gap-1.5">
        <Tile
          label="Betrayals committed"
          value={tally.betrayalsCommitted}
          icon={Swords}
          alarm={true}
        />
        <Tile
          label="Betrayals suffered"
          value={tally.betrayalsSuffered}
          icon={Skull}
          alarm={true}
        />
      </dl>
      {betrayals.length === 0 ? null : (
        <ul className="flex flex-col gap-1">
          {betrayals.toReversed().map((b) => (
            <BetrayalLine key={b.id} item={b} seat={seat} />
          ))}
        </ul>
      )}
      <p className="text-muted-foreground text-[0.7rem]">
        {complete
          ? "So far, at the time shown. A betrayal is an attack that landed on an ally or a pact partner."
          : "Counted over the part of the match loaded so far (earlier lines are still loading)."}
      </p>
    </div>
  );
}

// Hour by hour ----------------------------------------------------------------------------------

const scoreOf = (p: HourPoint): number => p.score;
const citiesOf = (p: HourPoint): number => p.cities;

function Spark({
  label,
  noun,
  points,
  value,
  step,
  color,
}: {
  readonly label: string;
  readonly noun: (n: number) => string;
  readonly points: readonly HourPoint[];
  readonly value: (p: HourPoint) => number;
  readonly step: boolean;
  readonly color: string;
}) {
  const spark = useMemo(() => sparkOf(points, value, step), [points, value, step]);
  const [hover, setHover] = useState<number | null>(null);
  const i = hover ?? points.length - 1;
  const p = points[i];
  const first = points[0];
  const last = points.at(-1);
  let peak = first;
  for (const x of points) if (peak === undefined || value(x) > value(peak)) peak = x;
  const summary =
    first === undefined || last === undefined || peak === undefined
      ? `${label}: no checkpoint yet`
      : `${label} by game hour: ${noun(value(first))} at ${fmtTime(first.t)}, ${noun(value(last))} at ${fmtTime(last.t)}; highest ${noun(value(peak))} at ${fmtTime(peak.t)}`;
  const move = (e: PointerEvent<HTMLDivElement>): void => {
    const box = e.currentTarget.getBoundingClientRect();
    if (box.width <= 0) return;
    setHover(nearest(spark.xs, ((e.clientX - box.left) / box.width) * 100));
  };
  return (
    <figure className="flex min-w-0 flex-col gap-1">
      <figcaption className="flex items-baseline justify-between gap-2 text-xs">
        <span className="text-muted-foreground">{label}</span>
        {p === undefined ? null : (
          <span className="truncate">
            <strong className="font-semibold tabular-nums">{fmtInt(value(p))}</strong>{" "}
            <span className="text-muted-foreground">{fmtTime(p.t)}</span>
          </span>
        )}
      </figcaption>
      <p className="sr-only">{summary}</p>
      <div
        aria-hidden="true"
        onPointerMove={move}
        onPointerDown={move}
        onPointerLeave={() => setHover(null)}
        className="border-border relative h-10 touch-pan-y border-b"
      >
        <svg
          aria-hidden="true"
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          className="absolute inset-0 size-full overflow-visible"
        >
          <path
            d={spark.path}
            fill="none"
            stroke={color}
            strokeWidth={2}
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
        {hover === null ? null : (
          <span
            aria-hidden="true"
            className="bg-muted-foreground/60 pointer-events-none absolute inset-y-0 w-px"
            style={{ left: `${spark.xs[i] ?? 0}%` }}
          />
        )}
        {p === undefined ? null : (
          <span
            aria-hidden="true"
            className="ring-background pointer-events-none absolute size-2 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2"
            style={{
              left: `${points.length === 1 ? 100 : (spark.xs[i] ?? 0)}%`,
              top: `${spark.ys[i] ?? 0}%`,
              background: color,
            }}
          />
        )}
      </div>
    </figure>
  );
}

function HourTable({ points }: { readonly points: readonly HourPoint[] }) {
  const [open, setOpen] = useState(false);
  return (
    <details onToggle={(e) => setOpen(e.currentTarget.open)} className="text-xs">
      <summary className="text-primary hover:text-primary/80 w-fit cursor-pointer font-medium">
        As a table
      </summary>
      {open ? (
        <div className="mt-1 max-h-48 overflow-y-auto rounded-md border">
          <table className="w-full text-left tabular-nums">
            <thead className="text-muted-foreground bg-muted/50 sticky top-0">
              <tr>
                <th className="px-2 py-1 font-medium">Game time</th>
                <th className="px-2 py-1 text-right font-medium">Score</th>
                <th className="px-2 py-1 text-right font-medium">Cities</th>
              </tr>
            </thead>
            <tbody>
              {points.toReversed().map((p) => (
                <tr key={p.t} className="border-t">
                  <td className="px-2 py-0.5">{fmtTime(p.t)}</td>
                  <td className="px-2 py-0.5 text-right">{fmtInt(p.score)}</td>
                  <td className="px-2 py-0.5 text-right">{fmtInt(p.cities)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </details>
  );
}

/** Score and cities at every game hour up to the playhead. */
export function HourlyCharts({
  dossier,
  color,
}: {
  readonly dossier: PlayerDossier | null;
  readonly color: string;
}) {
  const hourly = dossier?.hourly ?? NO_POINTS;
  const n = useMatch((s) => countUntil(hourly, s.playhead));
  const points = useMemo(() => hourly.slice(0, n), [hourly, n]);
  if (dossier === null) return <Loading />;
  if (points.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        No hourly checkpoint yet at this time (the first is at {fmtTime(3_600)}).
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-2" data-testid="hourly">
      <div className="grid grid-cols-2 gap-3">
        <Spark
          label="Score"
          noun={(v) => `${fmtInt(v)} points`}
          points={points}
          value={scoreOf}
          step={false}
          color={color}
        />
        <Spark
          label="Cities"
          noun={(v) => plural(v, "city", "cities")}
          points={points}
          value={citiesOf}
          step={true}
          color={color}
        />
      </div>
      <HourTable points={points} />
    </div>
  );
}

const NO_POINTS: readonly HourPoint[] = Object.freeze([]);

function Loading() {
  return (
    <p className="text-muted-foreground flex items-center gap-2 text-xs">
      <Loader2 className="size-3 motion-safe:animate-spin" aria-hidden="true" /> Loading…
    </p>
  );
}

// The notebook ----------------------------------------------------------------------------------

interface Notebook {
  readonly versions: readonly NotebookVersion[];
  /** Each version's whole text (null when the history cannot be read). */
  readonly texts: readonly string[] | null;
  /** Versions written that the dossier no longer keeps (the oldest). */
  readonly dropped: number;
}

function useNotebook(dossier: PlayerDossier | null): Notebook & { readonly n: number } {
  const nb = dossier?.notebook ?? null;
  const notebook = useMemo<Notebook>(
    () =>
      nb === null
        ? { versions: [], texts: [], dropped: 0 }
        : {
            versions: nb.versions,
            texts: notebookTexts(nb),
            dropped: Math.max(0, nb.total - nb.versions.length),
          },
    [nb],
  );
  const n = useMatch((s) => countUntil(notebook.versions, s.playhead));
  return { ...notebook, n };
}

function NotebookBox({ text }: { readonly text: string }) {
  const shown = useMemo(() => layout(text), [text]);
  return (
    <>
      {shown.json ? (
        <p className="text-muted-foreground mb-1 text-xs">
          A scripted bot's memory, as data (laid out for reading).
        </p>
      ) : null}
      <div className="bg-muted/50 max-h-64 overflow-y-auto rounded-md border p-2 font-mono text-xs">
        <PlainText text={shown.text} />
      </div>
    </>
  );
}

/** The notebook as it was at the playhead. */
export function NotebookAt({ dossier }: { readonly dossier: PlayerDossier | null }) {
  const nb = useNotebook(dossier);
  if (dossier === null) return <Loading />;
  if (nb.texts === null) return <NotebookBox text={dossier.notes} />;
  const v = nb.versions[nb.n - 1];
  const text = nb.texts[nb.n - 1];
  if (v === undefined || text === undefined) {
    return (
      <p className="text-muted-foreground text-sm">
        {nb.dropped > 0 && nb.versions.length > 0
          ? `Not kept for this time: the dossier keeps the latest ${fmtInt(nb.versions.length)} versions.`
          : "(empty at this time)"}
      </p>
    );
  }
  return (
    <div data-testid="notebook-at">
      <p className="text-muted-foreground mb-1 text-[0.7rem]">
        As written in{" "}
        <OpenTurnButton
          seat={dossier.seat.seat}
          turn={v.turn}
          className="inline-flex text-[0.7rem]"
        >
          turn {v.turn}
        </OpenTurnButton>
        , at <GameTime t={v.t} />
      </p>
      {text === "" ? (
        <p className="text-muted-foreground text-sm">(emptied)</p>
      ) : (
        <NotebookBox text={text} />
      )}
    </div>
  );
}

const VERSIONS_SHOWN = 8;
const VERSIONS_MORE = 20;
const LINES_SHOWN = 14;
/** Lines each "more" adds to an opened version (a rewrite can run to thousands of lines). */
const LINES_MORE = 400;

function DiffRow({ line }: { readonly line: DiffLine }) {
  const mark = line.kind === "add" ? "+" : line.kind === "del" ? "−" : " ";
  return (
    <div
      data-diff={line.kind}
      className={cn(
        "flex gap-1.5 px-1.5",
        line.kind === "add" && "bg-primary/10",
        line.kind === "del" && "bg-destructive/15 text-muted-foreground",
        line.kind === "same" && "text-muted-foreground",
      )}
    >
      <span aria-hidden="true" className="w-2 shrink-0 select-none">
        {mark}
      </span>
      <span className="sr-only">
        {line.kind === "add" ? "added: " : line.kind === "del" ? "removed: " : ""}
      </span>
      <PlainText text={line.text === "" ? " " : line.text} className="min-w-0" />
    </div>
  );
}

interface Row {
  readonly key: string;
  /** A diff line, or a count of unchanged lines left out. */
  readonly line: DiffLine | null;
  readonly skip: number;
}

/** The rows a version shows: its changes with context, or (the oldest kept) all its lines. */
function rowsOf(text: string, prev: string | null, whole: boolean): Row[] {
  const now = layout(text).text;
  if (whole) {
    return now
      .split("\n")
      .map((t, i) => ({ key: `w${i}`, line: { kind: "same", text: t }, skip: 0 }));
  }
  const { hunks, after } = hunksOf(lineDiff(prev === null ? "" : layout(prev).text, now));
  const rows: Row[] = [];
  for (const [h, hunk] of hunks.entries()) {
    if (hunk.skipped > 0) rows.push({ key: `s${h}`, line: null, skip: hunk.skipped });
    for (const [l, line] of hunk.lines.entries()) rows.push({ key: `${h}:${l}`, line, skip: 0 });
  }
  if (after > 0 && rows.length > 0) rows.push({ key: "after", line: null, skip: after });
  return rows;
}

function Version({
  seat,
  version,
  text,
  prev,
  first,
  earliestKept,
}: {
  readonly seat: PlayerId;
  readonly version: NotebookVersion;
  readonly text: string;
  /** The version before (null for the first version kept). */
  readonly prev: string | null;
  /** The first version ever written. */
  readonly first: boolean;
  /** The oldest version kept, whose predecessor is not: shown whole. */
  readonly earliestKept: boolean;
}) {
  const [limit, setLimit] = useState(LINES_SHOWN);
  const id = useId();
  const rows = useMemo(() => rowsOf(text, prev, earliestKept), [text, prev, earliestKept]);
  const stats = useMemo(
    () => diffStats(rows.flatMap((r) => (r.line === null ? [] : [r.line]))),
    [rows],
  );
  const shown = rows.slice(0, limit);
  const hidden = rows.length - shown.length;
  const what = first
    ? "first version"
    : earliestKept
      ? "earliest version kept"
      : version.mode === "append"
        ? "added to it"
        : "rewrote it";
  return (
    <li className="border-border/60 flex flex-col gap-1 border-t pt-2 first:border-t-0 first:pt-0">
      <p className="text-muted-foreground flex flex-wrap items-center gap-x-1.5 text-[0.7rem]">
        <span>
          <OpenTurnButton seat={seat} turn={version.turn} className="inline-flex text-[0.7rem]">
            turn {version.turn}
          </OpenTurnButton>{" "}
          · <GameTime t={version.t} /> · {what}
        </span>
        {earliestKept ? null : (
          <span className="tabular-nums">
            <span className="text-primary">+{fmtInt(stats.add)}</span>{" "}
            <span className="text-destructive">−{fmtInt(stats.del)}</span>
            <span className="sr-only"> lines added and removed</span>
          </span>
        )}
      </p>
      {text === "" && prev !== null ? (
        <p className="text-muted-foreground text-xs">Emptied the notebook.</p>
      ) : (
        <div
          id={id}
          className="overflow-hidden rounded-md border font-mono text-[0.7rem] leading-snug"
        >
          {shown.map((r) =>
            r.line === null ? (
              <div key={r.key} className="text-muted-foreground bg-muted/40 px-1.5 italic">
                ⋯ {plural(r.skip, "line")} unchanged
              </div>
            ) : (
              <DiffRow key={r.key} line={r.line} />
            ),
          )}
        </div>
      )}
      {hidden > 0 ? (
        <button
          type="button"
          aria-controls={id}
          onClick={() => setLimit((l) => l + LINES_MORE)}
          className="text-primary hover:text-primary/80 w-fit text-xs font-medium"
        >
          {hidden > LINES_MORE
            ? `Show ${fmtInt(LINES_MORE)} more lines (${fmtInt(hidden)} not shown)`
            : earliestKept
              ? "Show it all"
              : "Show the whole change"}
        </button>
      ) : null}
    </li>
  );
}

/** The notebook's changes up to the playhead, newest first. */
export function NotebookHistory({ dossier }: { readonly dossier: PlayerDossier | null }) {
  const nb = useNotebook(dossier);
  const [limit, setLimit] = useState(VERSIONS_SHOWN);
  if (dossier === null) return <Loading />;
  const texts = nb.texts;
  if (texts === null) {
    return (
      <p className="text-muted-foreground text-sm">The notebook's history could not be read.</p>
    );
  }
  if (nb.n === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        {nb.dropped > 0 && nb.versions.length > 0
          ? `No version kept for this time: the dossier keeps the latest ${fmtInt(nb.versions.length)} of ${fmtInt(nb.versions.length + nb.dropped)}.`
          : "Not written yet at this time."}
      </p>
    );
  }
  const indexes = Array.from({ length: nb.n }, (_, i) => nb.n - 1 - i).slice(0, limit);
  return (
    <div className="flex flex-col gap-2" data-testid="notebook-history">
      <p className="text-muted-foreground text-[0.7rem]">
        {plural(nb.n + nb.dropped, "version")} so far
        {nb.dropped > 0 ? ` (the oldest ${fmtInt(nb.dropped)} not kept)` : ""}, newest first; each
        against the one before.
      </p>
      <ol className="flex flex-col gap-2">
        {indexes.map((i) => {
          const v = nb.versions[i];
          const text = texts[i];
          if (v === undefined || text === undefined) return null;
          return (
            <Version
              key={`${v.t}:${i}`}
              seat={dossier.seat.seat}
              version={v}
              text={text}
              prev={i === 0 ? null : (texts[i - 1] ?? null)}
              first={i === 0 && nb.dropped === 0}
              earliestKept={i === 0 && nb.dropped > 0}
            />
          );
        })}
      </ol>
      {nb.n > limit ? (
        <button
          type="button"
          onClick={() => setLimit((l) => l + VERSIONS_MORE)}
          className="text-primary hover:text-primary/80 w-fit text-xs font-medium"
        >
          Show {fmtInt(Math.min(VERSIONS_MORE, nb.n - limit))} older versions
        </button>
      ) : null}
    </div>
  );
}
