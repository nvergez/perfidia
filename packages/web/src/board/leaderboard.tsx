import { PlayerLabel } from "../common/player-label.tsx";
import { fmtInt } from "../lib/format.ts";
import { useStandings } from "../store/hooks.ts";
import { uiActions } from "../store/ui.ts";

// STUB (owned by view agent B, phase-3 design §4.3 "Leaderboard"): rank, player, model, score and
// cities at the playhead. Agent B replaces this file; the export name and the no-props signature
// stay.

export function Leaderboard() {
  const standings = useStandings();
  return (
    <section
      data-stub="leaderboard"
      aria-label="Leaderboard"
      className="bg-card rounded-xl border p-3"
    >
      <h2 className="text-muted-foreground mb-2 text-xs font-semibold tracking-wider uppercase">
        Leaderboard
      </h2>
      <ol className="flex flex-col gap-1">
        {standings.map((s) => (
          <li key={s.player} data-player={s.player} className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground w-4 tabular-nums">{s.rank}</span>
            <button
              type="button"
              className="min-w-0 flex-1 text-left"
              onClick={() => uiActions.openPlayer(s.player)}
              onMouseEnter={() => uiActions.setHighlight([s.player])}
              onMouseLeave={() => uiActions.setHighlight([])}
              onFocus={() => uiActions.setHighlight([s.player])}
              onBlur={() => uiActions.setHighlight([])}
            >
              <PlayerLabel player={s.player} model />
            </button>
            <span className="font-mono tabular-nums">{fmtInt(s.score)}</span>
            <span className="text-muted-foreground w-8 text-right tabular-nums">{s.cities}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}
