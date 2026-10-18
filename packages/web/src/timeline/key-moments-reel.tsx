import { useUi } from "../store/hooks.ts";
import { uiActions } from "../store/ui.ts";
import { Button } from "../ui/button.tsx";

// STUB (owned by view agent A, phase-3 design §4.3 "Key moments reel"): shown while the reel is
// active (`uiStore.reelActive`, set from `?reel=1` once "How to watch" is closed). Agent A replaces
// this file; the export name and the no-props signature stay.

export function KeyMomentsReel() {
  const active = useUi((s) => s.reelActive);
  if (!active) return null;
  return (
    <div
      data-stub="reel"
      className="bg-popover fixed inset-x-4 bottom-24 z-40 mx-auto flex max-w-lg items-center justify-between gap-3 rounded-xl border p-3 shadow-lg"
    >
      <span className="text-sm">Key moments reel</span>
      <Button size="sm" variant="secondary" onClick={() => uiActions.stopReel()}>
        Stop
      </Button>
    </div>
  );
}
