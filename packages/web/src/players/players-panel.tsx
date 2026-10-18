import { PlayerLabel } from "../common/player-label.tsx";
import { useSeats } from "../store/hooks.ts";
import { uiActions } from "../store/ui.ts";

// STUB (owned by view agent B, phase-3 design §4.2 "Player card and minimal dossier"): every seat;
// a click opens its dossier sheet. Agent B replaces this file; the export name and the no-props
// signature stay.

export function PlayersPanel() {
  const seats = useSeats();
  return (
    <ul data-stub="players" aria-label="Players" className="flex flex-col gap-1 text-sm">
      {seats.map((s) => (
        <li key={s.seat}>
          <button
            type="button"
            className="hover:bg-accent w-full rounded px-1 py-0.5 text-left"
            onClick={() => uiActions.openPlayer(s.seat)}
          >
            <PlayerLabel player={s.seat} model />
          </button>
        </li>
      ))}
    </ul>
  );
}
