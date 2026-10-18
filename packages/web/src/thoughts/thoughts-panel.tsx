import { PlainText } from "../common/plain-text.tsx";
import { PlayerLabel } from "../common/player-label.tsx";
import { useFrame, useSeats } from "../store/hooks.ts";

// STUB (owned by view agent B, phase-3 design §4.3 "Thoughts"): each seat's last public thought.
// Agent B replaces this file; the export name and the no-props signature stay.

export function ThoughtsPanel() {
  const seats = useSeats();
  const frame = useFrame();
  return (
    <ul data-stub="thoughts" aria-label="Thoughts" className="flex flex-col gap-3 text-sm">
      {seats.map((s) => {
        const thought = frame?.seats[s.seat]?.lastThought ?? null;
        return (
          <li key={s.seat}>
            <PlayerLabel player={s.seat} model />
            <p className="text-muted-foreground mt-1">
              {thought === null ? "No thought yet." : <PlainText text={thought.text} />}
            </p>
          </li>
        );
      })}
    </ul>
  );
}
