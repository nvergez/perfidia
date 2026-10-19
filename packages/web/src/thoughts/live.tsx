import { Brain } from "lucide-react";
import { useMemo, useState } from "react";
import { NotPublished } from "../common/not-published.tsx";
import { PlainText } from "../common/plain-text.tsx";
import { cn } from "../lib/cn.ts";
import { fmtInt, plural } from "../lib/format.ts";
import type { PlayerId } from "../lib/ids.ts";
import { useLiveAnnots, usePublished } from "../store/hooks.ts";
import { OpenTurnButton } from "../turns/open-turn.tsx";
import { roundTitle, type RoundRow } from "../turns/detail.ts";
import { liveView } from "./live-rounds.ts";

// The live per-round reasoning in the Thoughts column (phase-3 design §4.2 Pass C, C3): while
// `seat` is in turn `turn` of a live match, the rounds of that turn as the WebSocket's `annot`
// messages bring them (`useLiveAnnots`: arrival order, a resent round replaced in place; on a
// reconnect the server sends the open turns' rounds again, which replace, never duplicate), newest
// last. The newest round shows a few lines, the two before it one line each, older ones are
// counted; "more" shows them all, whole. A new round fades in only when motion is allowed. When the
// turn ends the column unmounts this block and the turn's thought takes its place, its "Reasoning"
// opening at once on these rounds (`turn-reasoning.tsx`) while the annotation loads. Mounted by
// `thoughts-panel.tsx` through `LazyLiveReasoning`.

export interface LiveReasoningProps {
  readonly seat: PlayerId;
  readonly turn: number;
}

/** A round longer than its clamp shows (about three lines for the newest, one for the others). */
function longer(r: RoundRow, latest: boolean): boolean {
  const n = r.reasoning.join("\n").length + r.text.join("\n").length;
  return n > (latest ? 150 : 50) || r.reasoning.length + r.text.length > (latest ? 3 : 1);
}

export function LiveReasoning({ seat, turn }: LiveReasoningProps) {
  const msgs = useLiveAnnots(seat, turn);
  const published = usePublished();
  const [more, setMore] = useState(false);
  const view = useMemo(() => liveView(msgs, more), [msgs, more]);
  const clamped = view.earlier > 0 || view.rounds.some((r) => longer(r, r.key === view.latest));
  const detail = (
    <OpenTurnButton seat={seat} turn={turn}>
      Turn detail (in progress)
    </OpenTurnButton>
  );
  // Nothing yet (no reply so far, or a replay, which has no live rounds): no box, no layout shift
  // as turns open and close while a replay plays; the header says "thinking…".
  if (view.rounds.length === 0) return <span hidden data-live-reasoning={`${seat}:${turn}`} />;
  return (
    <section
      aria-label={`Live reasoning, turn ${fmtInt(turn)}`}
      data-live-reasoning={`${seat}:${turn}`}
      className="border-primary/40 bg-primary/5 mt-2 flex flex-col gap-1.5 rounded-r-md border-l-2 px-2.5 py-1.5"
    >
      {published.reasoning ? null : <NotPublished what="Reasoning" />}
      {view.earlier === 0 ? null : (
        <p className="text-muted-foreground text-[0.7rem]">
          {plural(view.earlier, "earlier round")} not shown
        </p>
      )}
      <ol className="flex flex-col gap-1.5">
        {view.rounds.map((r) => {
          const latest = r.key === view.latest;
          const clamp = more ? null : latest ? "line-clamp-3" : "line-clamp-1";
          return (
            <li
              key={r.key}
              data-live-round={r.key}
              className="motion-safe:animate-in motion-safe:fade-in-0 flex flex-col gap-0.5"
            >
              <p className="text-muted-foreground flex min-w-0 items-center gap-1 text-[0.7rem]">
                <Brain className="size-3 shrink-0" aria-hidden="true" />
                <span className="shrink-0 font-semibold tracking-wider whitespace-nowrap uppercase">
                  {roundTitle(r)}
                </span>
                {r.calls.length === 0 ? null : (
                  <span className="truncate font-mono">
                    · {r.calls.map((c) => c.tool).join(", ")}
                  </span>
                )}
              </p>
              {r.reasoning.length === 0 ? null : (
                <PlainText
                  text={r.reasoning.join("\n")}
                  className={cn("text-foreground/90 block text-xs italic", clamp)}
                />
              )}
              {r.text.length === 0 ? null : (
                <PlainText text={r.text.join("\n")} className={cn("block text-xs", clamp)} />
              )}
            </li>
          );
        })}
      </ol>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {more || clamped ? (
          <button
            type="button"
            aria-expanded={more}
            onClick={() => setMore((m) => !m)}
            className="text-primary hover:text-primary/80 text-xs font-medium"
          >
            {more ? "less" : "more"}
          </button>
        ) : null}
        {detail}
      </div>
    </section>
  );
}
