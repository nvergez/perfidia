import { PlayerLabel } from "../common/player-label.tsx";
import { useDomination, useRuleSentence } from "../store/hooks.ts";

// STUB (owned by view agent B, phase-3 design §4.3 "Bloc progress"): the rule sentence and each
// bloc's cities against the threshold. Agent B replaces this file; the export name and the no-props
// signature stay.

export function BlocProgress() {
  const rule = useRuleSentence();
  const d = useDomination();
  return (
    <section data-stub="blocs" aria-label="Blocs" className="bg-card rounded-xl border p-3">
      <h2 className="text-muted-foreground mb-2 text-xs font-semibold tracking-wider uppercase">
        How to win
      </h2>
      {rule === null ? null : <p className="mb-2 text-sm">{rule}</p>}
      {d === null ? null : (
        <ul className="flex flex-col gap-1 text-sm">
          {d.blocs.map((b) => (
            <li key={b.key} className="flex flex-wrap items-center gap-x-2">
              {b.members.map((m) => (
                <PlayerLabel key={m} player={m} />
              ))}
              <span className="ml-auto font-mono tabular-nums">
                {b.cities}/{d.need ?? "?"} · {b.taken}/{d.needTaken ?? "?"} taken
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
