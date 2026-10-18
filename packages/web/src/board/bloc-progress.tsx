import type { Frame } from "@perfidia/protocol/spectator";
import { Crown, Hourglass, Lock } from "lucide-react";
import { Fragment } from "react";
import { GameTime } from "../common/game-time.tsx";
import { PlainText } from "../common/plain-text.tsx";
import { PlayerGlyph } from "../common/player-glyph.tsx";
import { Who } from "../feed/bits.tsx";
import { cn } from "../lib/cn.ts";
import { playerColor } from "../lib/colors.ts";
import { fmtInt } from "../lib/format.ts";
import { fmtSpan } from "../lib/time.ts";
import type { DominationBloc, DominationView } from "../skins/index.ts";
import { useDomination, useMatch, useRuleSentence, useSeats } from "../store/hooks.ts";
import { uiActions } from "../store/ui.ts";
import {
  blocStanding,
  cityShare,
  countdownOf,
  countdownProgress,
  splitBlocs,
  takenPips,
  type BlocStanding,
} from "./board.ts";

// Bloc progress (phase-3 design §4.3): the win rule in one sentence (numbers from the match, from
// the skin), then one row per bloc: its cities against the number a win needs, its cities taken by
// conquest as pips against the number needed, and a running countdown with its end and the time
// left. Each row says where the bloc stands: won, counting down, holding the cities but short of
// conquests (so no countdown), or short of cities. Lone players short of the cities share one line.
// Before the domination window opens the section says when it opens and the rows are dimmed.
// Hovering a bloc highlights its members on the map.

const NO_ALLIANCES: Frame["alliances"] = Object.freeze({});

const clearHighlight = (): void => uiActions.setHighlight([]);

/** The game minute of the playhead (a coarser subscription than the playhead itself). */
const useMinute = (): number => useMatch((s) => Math.floor(s.playhead / 60) * 60);

/** The words for a bloc's standing (the countdown has its own line). */
function StandingNote({
  st,
  over,
  needTaken,
}: {
  readonly st: BlocStanding;
  readonly over: boolean;
  readonly needTaken: number | null;
}) {
  if (st.kind === "won") {
    return (
      <span className="text-gold inline-flex items-center gap-1 font-semibold">
        <Crown className="size-3" aria-hidden="true" /> won the match
      </span>
    );
  }
  if (st.kind === "needs-taken") {
    return (
      <span
        className="text-foreground/85"
        title={`The cities are enough, but a countdown also needs ${fmtInt(needTaken ?? 0)} of them taken by conquest`}
      >
        {over ? "was" : "is"} {fmtInt(st.missing)} conquest{st.missing === 1 ? "" : "s"} short of a
        countdown
      </span>
    );
  }
  if (st.kind === "needs-cities") {
    return (
      <span>
        {fmtInt(st.missing)} {st.missing === 1 ? "city" : "cities"} short
      </span>
    );
  }
  return null;
}

function BlocRow({
  bloc,
  d,
  name,
  t,
  winners,
  over,
}: {
  readonly bloc: DominationBloc;
  readonly d: DominationView;
  readonly name: string | null;
  readonly t: number;
  readonly winners: readonly string[] | null;
  readonly over: boolean;
}) {
  const seats = useSeats();
  const first = seats.find((s) => s.seat === bloc.members[0]);
  const color = first === undefined ? playerColor(0) : playerColor(first.color);
  const share = cityShare(bloc.cities, d.need);
  const pips = takenPips(bloc.taken, d.needTaken).map((on, i) => ({ key: `pip${i}`, on }));
  const countdown = countdownOf(d, bloc.key);
  const progress = countdown === null ? null : countdownProgress(countdown, d.hold, t);
  const enough = d.need !== null && bloc.cities >= d.need;
  // A match too short for a countdown: no bloc is "short" of anything.
  const st: BlocStanding = impossible(d) ? { kind: "none" } : blocStanding(bloc, d, winners);
  const won = st.kind === "won";
  const highlight = (): void => uiActions.setHighlight(bloc.members);
  return (
    // oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- hovering a bloc only highlights its members on the map; the row names them in text
    <li
      data-bloc={bloc.key}
      onMouseEnter={highlight}
      onMouseLeave={clearHighlight}
      className={cn(
        "flex flex-col gap-1 rounded-lg px-1.5 py-1",
        (countdown !== null || won) && "bg-gold/10 ring-gold/50 ring-1",
      )}
    >
      <div className="flex min-w-0 items-baseline gap-2 text-sm">
        <span className="min-w-0 flex-1">
          {name === null ? (
            bloc.members.map((m) => <Who key={m} id={m} />)
          ) : (
            <>
              <PlainText text={name} className="font-medium italic" />{" "}
              <span className="text-muted-foreground text-xs whitespace-nowrap">
                {bloc.members.map((m) => (
                  <span key={m} className="mr-1.5 inline-flex items-center gap-0.5">
                    <PlayerGlyph color={seats.find((s) => s.seat === m)?.color ?? null} size={9} />
                    <span className="font-mono">{m}</span>
                  </span>
                ))}
              </span>
            </>
          )}
        </span>
        <span
          className={cn(
            "shrink-0 font-mono text-xs tabular-nums",
            enough && "text-gold font-semibold",
          )}
          aria-label={`${fmtInt(bloc.cities)} of ${d.need === null ? "?" : fmtInt(d.need)} cities`}
        >
          {fmtInt(bloc.cities)}/{d.need === null ? "?" : fmtInt(d.need)}
        </span>
      </div>
      <div aria-hidden="true" className="bg-muted relative h-2 overflow-hidden rounded-full">
        <span
          className="block h-full rounded-full"
          style={{ width: `${share * 100}%`, backgroundColor: enough ? "var(--gold)" : color }}
        />
      </div>
      {pips.length === 0 && countdown === null && st.kind === "none" ? null : (
        <div className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
          {pips.length === 0 ? null : (
            <span
              className="inline-flex items-center gap-1"
              aria-label={`${fmtInt(Math.min(bloc.taken, d.needTaken ?? 0))} of ${fmtInt(d.needTaken ?? 0)} cities taken by conquest`}
            >
              taken
              {pips.map((p) => (
                <span
                  key={p.key}
                  aria-hidden="true"
                  className={cn(
                    "inline-block size-2 rounded-full border",
                    p.on ? "bg-gold border-gold" : "border-muted-foreground/60",
                  )}
                />
              ))}
              <span className="tabular-nums">
                {fmtInt(bloc.taken)}/{fmtInt(d.needTaken ?? 0)}
              </span>
            </span>
          )}
          {countdown === null ? null : (
            <span className="text-gold inline-flex items-center gap-1 font-medium">
              <Hourglass className="size-3" aria-hidden="true" />
              {countdown.endsAt === null ? (
                "countdown running"
              ) : (
                <>
                  wins at <GameTime t={countdown.endsAt} />
                  {countdown.endsAt > t ? ` · ${fmtSpan(countdown.endsAt - t)} left` : null}
                </>
              )}
            </span>
          )}
          {st.kind === "countdown" ? null : (
            <StandingNote st={st} over={over} needTaken={d.needTaken} />
          )}
        </div>
      )}
      {progress === null ? null : (
        <div className="bg-gold/20 h-1 overflow-hidden rounded-full" aria-hidden="true">
          <span className="bg-gold block h-full" style={{ width: `${progress * 100}%` }} />
        </div>
      )}
    </li>
  );
}

/** Domination cannot decide the match: the last start that could still win is before the opening. */
const impossible = (d: DominationView): boolean =>
  d.opensAt !== null && d.startBy !== null && d.startBy < d.opensAt;

function WindowLine({ d, t }: { readonly d: DominationView; readonly t: number }) {
  if (impossible(d)) return null;
  if (!d.open) {
    if (d.opensAt === null) return null;
    return (
      <p className="text-muted-foreground flex items-start gap-1.5 text-xs">
        <Lock className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
        <span>
          Domination opens{" "}
          {d.opensAt > t ? (
            <>
              in {fmtSpan(d.opensAt - t)} (<GameTime t={d.opensAt} />)
            </>
          ) : (
            <>
              at <GameTime t={d.opensAt} />
            </>
          )}
          ; until then the rows below are only a preview.
        </span>
      </p>
    );
  }
  if (d.countdowns.length > 0) return null;
  return (
    <p className="text-muted-foreground text-xs">
      Domination is open
      {d.startBy === null ? null : (
        <>
          : a countdown must start by <GameTime t={d.startBy} />
        </>
      )}
      .
    </p>
  );
}

/** Lone players short of the cities a win needs, on one line: "Alone: Rusher (bot) · p6 5, …". */
function AloneLine({
  blocs,
  need,
}: {
  readonly blocs: readonly DominationBloc[];
  readonly need: number | null;
}) {
  if (blocs.length === 0) return null;
  return (
    <li className="text-muted-foreground px-1.5 py-1 text-xs leading-relaxed">
      Alone:{" "}
      {blocs.map((b, i) => (
        <Fragment key={b.key}>
          {i > 0 ? ", " : null}
          <span className="whitespace-nowrap">
            {b.members.map((m) => (
              <Who key={m} id={m} />
            ))}{" "}
            <span
              className="font-mono tabular-nums"
              aria-label={`${fmtInt(b.cities)} of ${need === null ? "?" : fmtInt(need)} cities`}
            >
              {fmtInt(b.cities)}/{need === null ? "?" : fmtInt(need)}
            </span>
          </span>
        </Fragment>
      ))}
    </li>
  );
}

const NO_WINNERS: readonly string[] = Object.freeze([]);

export function BlocProgress() {
  const rule = useRuleSentence();
  const d = useDomination();
  const alliances = useMatch((s) => s.frame?.alliances ?? NO_ALLIANCES);
  const t = useMinute();
  const over = useMatch((s) => (s.frame?.result ?? null) !== null);
  const winners = useMatch((s) => s.frame?.result?.winners ?? NO_WINNERS);
  const nameOf = (key: string): string | null =>
    Object.values(alliances).find((a) => a?.id === key)?.name ?? null;
  return (
    <section aria-label="How to win" data-testid="blocs" className="bg-card rounded-xl border p-3">
      <h2 className="text-muted-foreground mb-1.5 text-xs font-semibold tracking-wider uppercase">
        How to win
      </h2>
      {rule === null ? null : (
        <p className="mb-1.5 text-[0.8rem] leading-snug" data-testid="rule">
          {rule}
        </p>
      )}
      {d === null ? null : (
        <>
          {over ? null : <WindowLine d={d} t={t} />}
          <BlocList d={d} nameOf={nameOf} t={t} over={over} winners={over ? winners : null} />
        </>
      )}
    </section>
  );
}

function BlocList({
  d,
  nameOf,
  t,
  over,
  winners,
}: {
  readonly d: DominationView;
  readonly nameOf: (key: string) => string | null;
  readonly t: number;
  readonly over: boolean;
  readonly winners: readonly string[] | null;
}) {
  const { rows, alone } = splitBlocs(d.blocs, d, winners);
  return (
    <ol className={cn("mt-1.5 flex flex-col gap-1", !d.open && "opacity-60")}>
      {rows.map((b) => (
        <BlocRow
          key={b.key}
          bloc={b}
          d={d}
          name={nameOf(b.key)}
          t={t}
          winners={winners}
          over={over}
        />
      ))}
      <AloneLine blocs={alone} need={d.need} />
    </ol>
  );
}
