import type { Frame } from "@perfidia/protocol/spectator";
import { Hourglass, Lock } from "lucide-react";
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
import { cityShare, countdownOf, countdownProgress, sortBlocs, takenPips } from "./board.ts";

// Bloc progress (phase-3 design §4.3): the win rule in one sentence (numbers from the match, from
// the skin), then one row per bloc: its cities against the number a win needs, its cities taken by
// conquest as pips against the number needed, and a running countdown with its end and the time
// left. Before the domination window opens the section says when it opens and the rows are dimmed.
// Hovering a bloc highlights its members on the map.

const NO_ALLIANCES: Frame["alliances"] = Object.freeze({});

const clearHighlight = (): void => uiActions.setHighlight([]);

/** The game minute of the playhead (a coarser subscription than the playhead itself). */
const useMinute = (): number => useMatch((s) => Math.floor(s.playhead / 60) * 60);

function BlocRow({
  bloc,
  d,
  name,
  t,
}: {
  readonly bloc: DominationBloc;
  readonly d: DominationView;
  readonly name: string | null;
  readonly t: number;
}) {
  const seats = useSeats();
  const first = seats.find((s) => s.seat === bloc.members[0]);
  const color = first === undefined ? playerColor(0) : playerColor(first.color);
  const share = cityShare(bloc.cities, d.need);
  const pips = takenPips(bloc.taken, d.needTaken).map((on, i) => ({ key: `pip${i}`, on }));
  const countdown = countdownOf(d, bloc.key);
  const progress = countdown === null ? null : countdownProgress(countdown, d.hold, t);
  const enough = d.need !== null && bloc.cities >= d.need;
  const highlight = (): void => uiActions.setHighlight(bloc.members);
  return (
    // oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- hovering a bloc only highlights its members on the map; the row names them in text
    <li
      data-bloc={bloc.key}
      onMouseEnter={highlight}
      onMouseLeave={clearHighlight}
      className={cn(
        "flex flex-col gap-1 rounded-lg px-1.5 py-1.5",
        countdown !== null && "bg-gold/10 ring-gold/50 ring-1",
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
      {pips.length === 0 && countdown === null ? null : (
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

export function BlocProgress() {
  const rule = useRuleSentence();
  const d = useDomination();
  const alliances = useMatch((s) => s.frame?.alliances ?? NO_ALLIANCES);
  const t = useMinute();
  const over = useMatch((s) => (s.frame?.result ?? null) !== null);
  const nameOf = (key: string): string | null =>
    Object.values(alliances).find((a) => a?.id === key)?.name ?? null;
  return (
    <section aria-label="How to win" data-testid="blocs" className="bg-card rounded-xl border p-3">
      <h2 className="text-muted-foreground mb-1.5 text-xs font-semibold tracking-wider uppercase">
        How to win
      </h2>
      {rule === null ? null : (
        <p className="mb-2 text-sm leading-snug" data-testid="rule">
          {rule}
        </p>
      )}
      {d === null ? null : (
        <>
          {over ? null : <WindowLine d={d} t={t} />}
          <ol className={cn("mt-1.5 flex flex-col gap-1", !d.open && "opacity-60")}>
            {sortBlocs(d.blocs).map((b) => (
              <BlocRow key={b.key} bloc={b} d={d} name={nameOf(b.key)} t={t} />
            ))}
          </ol>
        </>
      )}
    </section>
  );
}
