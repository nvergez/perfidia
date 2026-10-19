import type { SeatInfo } from "@perfidia/protocol/spectator";
import { cn } from "../lib/cn.ts";
import { isFakeSeat, modelLabel, playedBy } from "../lib/models.ts";
import { Badge } from "../ui/badge.tsx";

// Who plays a seat: "Opus 5.5 · medium", "Bot", or "Fake" (a bot behind the LLM pipe, never shown
// as the model it stands in for). An unknown model id shows as it is, cut with an ellipsis at the
// badge's width (12 rem); the tooltip has it whole. In a tight row (`squeeze`, the leaderboard) a
// long label gives way first: at most 5 rem of text, shrinking eight times as fast as its
// neighbours down to 3 rem, while a short one ("Bot", "Opus 5.5 · medium") keeps its width.

/** Labels longer than this may shrink in a tight row. */
const LONG_LABEL = 12;

export function ModelBadge({
  seat,
  className,
  squeeze = false,
}: {
  readonly seat: Pick<SeatInfo, "kind" | "fake" | "model">;
  readonly className?: string;
  readonly squeeze?: boolean;
}) {
  const fake = isFakeSeat(seat);
  const label = modelLabel(seat);
  const long = squeeze && label.length > LONG_LABEL;
  return (
    <Badge
      variant="outline"
      title={playedBy(seat)}
      className={cn(
        "max-w-48 min-w-0 font-normal",
        fake && "border-gold/60 text-gold",
        seat.kind === "bot" && !fake && "text-muted-foreground",
        squeeze && (long ? "min-w-12 shrink-[8]" : "shrink-0"),
        className,
      )}
    >
      <span className={cn("min-w-0 truncate", long && "max-w-20")}>{label}</span>
    </Badge>
  );
}
