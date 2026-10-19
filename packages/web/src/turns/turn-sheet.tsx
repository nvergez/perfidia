import { GameTime } from "../common/game-time.tsx";
import { PlainText } from "../common/plain-text.tsx";
import { PlayerGlyph } from "../common/player-glyph.tsx";
import { useFeed, useSeat, useUi } from "../store/hooks.ts";
import { uiActions } from "../store/ui.ts";
import { wakeWords } from "../thoughts/wake.ts";
import { TurnReasoning } from "../thoughts/turn-reasoning.tsx";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "../ui/sheet.tsx";

// The turn detail (phase-3 design §4.2 Pass C, C1): a sheet for the turn in `uiStore.openTurn`.
// A placeholder made at step C0 (the turn's wake, thought and the Pass B reasoning); agent T
// replaces its body with the full detail (docs/phase3.md §16.4): the wake with its reasons and
// urgency, each round's reasoning, text and tool calls with ✓/✗ and codes, the messages sent next
// to the thought, the closing reason, cost and tokens. The export name and the props stay.

export function TurnSheet() {
  const open = useUi((s) => s.openTurn);
  const seat = useSeat(open?.seat ?? "");
  const feed = useFeed();
  const item =
    open === null
      ? null
      : (feed.findLast(
          (e) => e.item.k === "turn" && e.item.seat === open.seat && e.item.turn === open.turn,
        )?.item ?? null);
  const turn = item?.k === "turn" ? item : null;
  return (
    <Sheet
      open={open !== null}
      onOpenChange={(o) => {
        if (!o) uiActions.closeTurn();
      }}
    >
      <SheetContent data-testid="turn-sheet" className="w-full overflow-y-auto sm:max-w-lg">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2 pr-6 text-lg">
            {seat === null || open === null ? (
              "Turn"
            ) : (
              <>
                <PlayerGlyph color={seat.color} size={16} />
                <bdi className="truncate">{seat.name}</bdi>
                <span className="text-muted-foreground font-mono text-base font-normal">
                  · {seat.seat} · turn {open.turn}
                </span>
              </>
            )}
          </SheetTitle>
          <SheetDescription>
            {turn === null ? (
              "This turn has not ended at this point of the match."
            ) : (
              <>
                Woke <GameTime t={turn.wakeT ?? turn.t} /> for{" "}
                {turn.reasons.map(wakeWords).join("; ") || "no logged reason"}
                {turn.urgent ? " (urgent)" : ""}; ended <GameTime t={turn.t} />.
              </>
            )}
          </SheetDescription>
        </SheetHeader>
        {open === null ? null : (
          <div className="flex flex-col gap-3 px-4 pb-6">
            {turn?.thought === null || turn?.thought === undefined || turn.thought === "" ? null : (
              <PlainText text={turn.thought} className="block text-sm italic" />
            )}
            <TurnReasoning seat={open.seat} turn={open.turn} />
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
