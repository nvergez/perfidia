import type { ReportDetail } from "@perfidia/protocol/spectator";
import { Loader2, Swords } from "lucide-react";
import { useEffect, useMemo } from "react";
import { GameTime } from "../common/game-time.tsx";
import { PlayerLabel } from "../common/player-label.tsx";
import { isPlayerId } from "../lib/ids.ts";
import { fmtInt } from "../lib/format.ts";
import type { ReportStack } from "../skins/index.ts";
import { useMatch, useReport, useSkin, useUi } from "../store/hooks.ts";
import { loaders, controls } from "../store/session.ts";
import { uiActions } from "../store/ui.ts";
import { Button } from "../ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog.tsx";
import { fullestCopy } from "./derive.ts";

// The battle report (phase-3 design §4.2.5), opened from a battle on the map, a city's last battle
// or a feed card (`uiStore.selectedReport`). Every recipient got its own copy; the fullest one is
// shown (the defender's when the attacker's is redacted), rendered by the ruleset's skin.

function Value({ value }: { readonly value: string }) {
  return isPlayerId(value) ? <PlayerLabel player={value} /> : <span>{value}</span>;
}

function Stacks({ stacks }: { readonly stacks: readonly ReportStack[] }) {
  if (stacks.length === 0) return null;
  const sides = [...new Set(stacks.map((s) => s.side))];
  return (
    <div className="flex flex-col gap-3">
      {sides.map((side) => (
        <table key={side} className="w-full text-sm tabular-nums">
          <caption className="text-muted-foreground mb-1 text-left text-xs capitalize">
            {side === "" ? "Units" : side}
          </caption>
          <thead className="text-muted-foreground text-xs">
            <tr>
              <th className="text-left font-normal">Owner</th>
              <th className="text-left font-normal">Unit</th>
              <th className="text-right font-normal">Before</th>
              <th className="text-right font-normal">Lost</th>
              <th className="text-right font-normal">Left</th>
            </tr>
          </thead>
          <tbody>
            {stacks
              .filter((s) => s.side === side)
              .map((s) => (
                <tr key={`${s.owner}-${s.unit}`} className="border-t">
                  <td className="py-1 pr-2">
                    <Value value={s.owner} />
                  </td>
                  <td className="pr-2">{s.unit}</td>
                  <td className="text-right">{fmtInt(s.before)}</td>
                  <td
                    className={
                      s.lost > 0 ? "text-betrayal text-right" : "text-muted-foreground text-right"
                    }
                  >
                    {s.lost > 0 ? `−${fmtInt(s.lost)}` : "0"}
                  </td>
                  <td className="text-right">{fmtInt(s.survived)}</td>
                </tr>
              ))}
          </tbody>
        </table>
      ))}
    </div>
  );
}

function ReportBody({ id }: { readonly id: string }) {
  const skin = useSkin();
  const first = useReport(id);
  const copies = first?.status === "ok" ? first.value.copies : null;
  useEffect(() => {
    for (const c of copies ?? []) loaders.report(c);
  }, [copies]);
  const cache = useMatch((s) => s.reports);
  const best = useMemo((): ReportDetail | null => {
    if (first?.status !== "ok") return null;
    const all = [first.value];
    for (const c of first.value.copies) {
      const e = cache[c];
      if (e?.status === "ok") all.push(e.value);
    }
    return fullestCopy(all);
  }, [first, cache]);
  if (first === null || first.status === "loading" || first.status === "error") {
    return (
      <DialogHeader>
        <DialogTitle className="font-serif text-lg">Battle report</DialogTitle>
        <DialogDescription className="flex items-center gap-2">
          {first?.status === "error" ? (
            `This report could not be loaded: ${first.message}.`
          ) : (
            <>
              <Loader2 className="size-4 motion-safe:animate-spin" aria-hidden="true" /> Loading the
              report…
            </>
          )}
        </DialogDescription>
      </DialogHeader>
    );
  }
  if (best === null || skin === null) return null;
  const view = skin.report(best.type, best.data);
  return (
    <div className="flex flex-col gap-4">
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2 font-serif text-lg">
          <Swords className="size-4" aria-hidden="true" /> {view.title}
        </DialogTitle>
        <DialogDescription>
          <GameTime t={best.t} /> at <span className="font-mono">{best.city}</span>
          {best.recipient === null ? null : (
            <>
              {" "}
              · as reported to <span className="font-mono">{best.recipient}</span>
              {best.copies.length > 0 ? " (the fullest copy)" : null}
            </>
          )}
        </DialogDescription>
      </DialogHeader>
      <dl className="grid grid-cols-[7rem_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
        {view.rows.map((r) => (
          <div key={r.label} className="contents">
            <dt className="text-muted-foreground">{r.label}</dt>
            <dd className="min-w-0 break-words">
              <Value value={r.value} />
            </dd>
          </div>
        ))}
      </dl>
      <Stacks stacks={view.stacks} />
      <Button
        size="sm"
        variant="secondary"
        className="self-start"
        onClick={() => {
          controls.seekSeq(best.seq, best.t);
          uiActions.selectReport(null);
        }}
      >
        Go to this battle
      </Button>
    </div>
  );
}

export function ReportDialog() {
  const id = useUi((s) => s.selectedReport);
  return (
    <Dialog
      open={id !== null}
      onOpenChange={(o) => {
        if (!o) uiActions.selectReport(null);
      }}
    >
      <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-lg">
        {id === null ? null : <ReportBody id={id} />}
      </DialogContent>
    </Dialog>
  );
}
