import { cn } from "../lib/cn.ts";
import { useSeat } from "../store/hooks.ts";
import { ModelBadge } from "./model-badge.tsx";
import { PlayerGlyph } from "./player-glyph.tsx";

// A player as the views name it: glyph (colour and shape), name, and id, "Odysseus · p1"; the id is
// always visible. With `model`, the model badge follows.

export function PlayerLabel({
  player,
  model = false,
  className,
}: {
  readonly player: string;
  readonly model?: boolean;
  readonly className?: string;
}) {
  const seat = useSeat(player);
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1.5", className)}>
      <PlayerGlyph color={seat?.color ?? null} />
      <span className="truncate">
        {seat === null ? null : (
          <>
            <bdi>{seat.name}</bdi>
            <span className="text-muted-foreground"> · </span>
          </>
        )}
        <span className="text-muted-foreground font-mono text-[0.92em]">{player}</span>
      </span>
      {model && seat !== null ? <ModelBadge seat={seat} /> : null}
    </span>
  );
}
