import type { SeatInfo } from "@perfidia/protocol/spectator";
import { cn } from "../lib/cn.ts";
import { isFakeSeat, modelLabel, playedBy } from "../lib/models.ts";
import { Badge } from "../ui/badge.tsx";

// Who plays a seat: "Opus 5.5 · medium", "Bot", or "Fake" (a bot behind the LLM pipe, never shown
// as the model it stands in for).

export function ModelBadge({
  seat,
  className,
}: {
  readonly seat: Pick<SeatInfo, "kind" | "fake" | "model">;
  readonly className?: string;
}) {
  const fake = isFakeSeat(seat);
  return (
    <Badge
      variant="outline"
      title={playedBy(seat)}
      className={cn(
        "font-normal",
        fake && "border-gold/60 text-gold",
        seat.kind === "bot" && !fake && "text-muted-foreground",
        className,
      )}
    >
      {modelLabel(seat)}
    </Badge>
  );
}
