import { PlainText } from "../common/plain-text.tsx";
import { PlayerLabel } from "../common/player-label.tsx";
import { useDossier, useUi } from "../store/hooks.ts";
import { uiActions } from "../store/ui.ts";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "../ui/sheet.tsx";

// STUB (owned by view agent B, phase-3 design §4.2 "Player card and minimal dossier"): the side sheet
// of the selected player (`uiStore.selectedPlayer`) with its notebook. Agent B replaces this file;
// the export name and the no-props signature stay (it is mounted once by the match page).

export function PlayerSheet() {
  const seat = useUi((s) => s.selectedPlayer);
  const dossier = useDossier(seat);
  return (
    <Sheet
      open={seat !== null}
      onOpenChange={(open) => (open ? undefined : uiActions.closePlayer())}
    >
      <SheetContent data-stub="player-sheet" className="overflow-y-auto">
        <SheetHeader>
          <SheetTitle>{seat === null ? "Player" : <PlayerLabel player={seat} model />}</SheetTitle>
          <SheetDescription>Dossier</SheetDescription>
        </SheetHeader>
        <div className="px-4 pb-4 text-sm">
          {dossier?.status === "ok" ? (
            <PlainText
              text={dossier.value.notes === "" ? "(empty notebook)" : dossier.value.notes}
            />
          ) : (
            <span className="text-muted-foreground">Loading…</span>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
