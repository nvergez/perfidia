import type { ReportDetail } from "@perfidia/protocol/spectator";
import { ChevronDown, ChevronRight, Loader2, ScrollText } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { fmtInt } from "../lib/format.ts";
import { useMatch, useSkin } from "../store/hooks.ts";
import type { MatchState } from "../store/match.ts";
import { loaders } from "../store/session.ts";
import { Who } from "./bits.tsx";

// A battle's report under its card (phase-3 design §4.2.5), rendered by the skin. Every
// recipient's copy is loaded and the fullest one shown (a copy can be redacted for one side): the
// one listing the most unit stacks, then the longest.

function fullest(copies: readonly ReportDetail[]): ReportDetail | null {
  let best: ReportDetail | null = null;
  let bestScore = -1;
  for (const c of copies) {
    const stacks = Array.isArray(c.data["stacks"]) ? c.data["stacks"].length : 0;
    const score = stacks * 1_000_000 + JSON.stringify(c.data).length;
    if (score > bestScore) {
      best = c;
      bestScore = score;
    }
  }
  return best;
}

function loadedCopies(reports: MatchState["reports"], ids: readonly string[]): ReportDetail[] {
  const out: ReportDetail[] = [];
  for (const id of ids) {
    const r = reports[id];
    if (r?.status === "ok") out.push(r.value);
  }
  return out;
}

function ReportBody({ ids }: { readonly ids: readonly string[] }) {
  const skin = useSkin();
  const reports = useMatch((s) => s.reports);
  useEffect(() => {
    for (const id of ids) loaders.report(id);
  }, [ids]);
  const copies = loadedCopies(reports, ids);
  const failed = ids.every((id) => reports[id]?.status === "error");
  const r = fullest(copies);
  if (r === null || skin === null) {
    return (
      <p className="text-muted-foreground flex items-center gap-2 text-xs">
        {failed ? (
          "The report could not be loaded."
        ) : (
          <>
            <Loader2 className="size-3 motion-safe:animate-spin" aria-hidden="true" /> Loading the
            report…
          </>
        )}
      </p>
    );
  }
  const view = skin.report(r.type, r.data);
  return (
    <div className="flex flex-col gap-2 text-xs">
      <p className="font-medium">{view.title}</p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
        {view.rows.map((row) => (
          <div key={row.label} className="contents">
            <dt className="text-muted-foreground">{row.label}</dt>
            <dd className="min-w-0 break-words">{row.value}</dd>
          </div>
        ))}
      </dl>
      {view.stacks.length === 0 ? null : (
        <table className="w-full text-left tabular-nums">
          <thead className="text-muted-foreground">
            <tr>
              <th className="font-normal">Side</th>
              <th className="font-normal">Unit</th>
              <th className="text-right font-normal">Before</th>
              <th className="text-right font-normal">Lost</th>
              <th className="text-right font-normal">Left</th>
            </tr>
          </thead>
          <tbody>
            {view.stacks.map((s) => (
              <tr key={`${s.side}:${s.owner}:${s.unit}`}>
                <td className="pr-2">
                  <Who id={s.owner} />
                </td>
                <td>{s.unit}</td>
                <td className="text-right">{fmtInt(s.before)}</td>
                <td className="text-destructive text-right">{fmtInt(s.lost)}</td>
                <td className="text-right">{fmtInt(s.survived)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/** "Battle report" toggle under a battle card. */
export function BattleReport({ ids }: { readonly ids: readonly string[] }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  if (ids.length === 0) return null;
  return (
    <div className="mt-1.5">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((o) => !o)}
        className="text-primary hover:text-primary/80 flex items-center gap-1 text-xs font-medium"
      >
        {open ? (
          <ChevronDown className="size-3" aria-hidden="true" />
        ) : (
          <ChevronRight className="size-3" aria-hidden="true" />
        )}
        <ScrollText className="size-3" aria-hidden="true" /> Battle report
      </button>
      {open ? (
        <div id={id} className="bg-muted/50 mt-1.5 rounded-md p-2">
          <ReportBody ids={ids} />
        </div>
      ) : null}
    </div>
  );
}
