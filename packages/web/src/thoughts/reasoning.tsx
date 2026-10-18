import type { TurnAnnotation } from "@perfidia/protocol/spectator";
import { Brain, ChevronDown, ChevronRight, Loader2, RefreshCw } from "lucide-react";
import { useId, useState } from "react";
import { PlainText } from "../common/plain-text.tsx";
import { cn } from "../lib/cn.ts";
import type { PlayerId } from "../lib/ids.ts";
import { fmtUsd, plural } from "../lib/format.ts";
import { useAnnotation } from "../store/hooks.ts";
import { loaders } from "../store/session.ts";
import { Button } from "../ui/button.tsx";

// A turn's reasoning (phase-3 design §4.3 "Thoughts", §2.7 annotations): the reasoning summaries
// and reply text of each round, with the tools it called, fetched from the annotations route when
// the viewer opens it. Reasoning is model-authored text: plain text only. The full turn detail
// (tool results, tokens, latency) is Pass C.

/** Text blocks with keys (a round's blocks never reorder; equal blocks may repeat). */
function keyed(
  xs: readonly string[],
  prefix: string,
): { readonly key: string; readonly text: string }[] {
  return xs.map((text, i) => ({ key: `${prefix}${i}`, text }));
}

function turnCost(a: TurnAnnotation): number {
  return a.rounds.reduce((n, r) => n + r.costNanoUsd, 0);
}

function Rounds({ a }: { readonly a: TurnAnnotation }) {
  const any = a.rounds.some((r) => r.reasoning.length > 0 || r.text.length > 0);
  const cost = turnCost(a);
  return (
    <div className="flex flex-col gap-2">
      {any ? null : (
        <p className="text-muted-foreground text-xs">No reasoning or reply text was logged.</p>
      )}
      {a.rounds.map((r) => (
        <section key={`${r.kind}:${r.round}`} className="flex flex-col gap-1">
          <h4 className="text-muted-foreground text-[0.7rem] font-semibold tracking-wider uppercase">
            {r.kind === "thought_call" ? "Closing thought" : `Round ${r.round + 1}`}
            {r.refusal === null ? null : <span className="text-destructive"> · refused</span>}
            {r.errors.length === 0 ? null : (
              <span className="text-destructive"> · {plural(r.errors.length, "error")}</span>
            )}
          </h4>
          {keyed(r.reasoning, "r").map((b) => (
            <PlainText
              key={b.key}
              text={b.text}
              className="text-foreground/90 block text-sm italic"
            />
          ))}
          {keyed(r.text, "t").map((b) => (
            <PlainText key={b.key} text={b.text} className="block text-sm" />
          ))}
          {r.calls.length === 0 ? null : (
            <p className="text-muted-foreground font-mono text-[0.7rem]">
              Tools: {r.calls.join(", ")}
            </p>
          )}
        </section>
      ))}
      {cost === 0 && a.spentNanoUsd === null ? null : (
        <p className="text-muted-foreground text-xs">
          {cost === 0 ? null : <>This turn cost {fmtUsd(cost)}. </>}
          {a.spentNanoUsd === null ? null : (
            <>
              Spent so far {fmtUsd(a.spentNanoUsd)}
              {a.capNanoUsd === null ? null : <> of a {fmtUsd(a.capNanoUsd)} cap</>}.
            </>
          )}
        </p>
      )}
    </div>
  );
}

/** The reasoning of turn `turn` of `seat`, loaded when shown. */
export function TurnReasoning({ seat, turn }: { readonly seat: PlayerId; readonly turn: number }) {
  const a = useAnnotation(seat, turn, true);
  if (a === null || a.status === "loading") {
    return (
      <p className="text-muted-foreground flex items-center gap-2 text-xs">
        <Loader2 className="size-3 motion-safe:animate-spin" aria-hidden="true" /> Loading the
        reasoning…
      </p>
    );
  }
  if (a.status === "error") {
    return <p className="text-muted-foreground text-xs">{a.message}.</p>;
  }
  return (
    <div className="flex flex-col gap-2">
      <Rounds a={a.value} />
      {a.value.complete ? null : (
        <p className="text-muted-foreground flex items-center gap-2 text-xs">
          This turn's side files may still grow.
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-1.5 text-xs"
            onClick={() => loaders.annotation(seat, turn, true)}
          >
            <RefreshCw className="size-3" aria-hidden="true" /> Refresh
          </Button>
        </p>
      )}
    </div>
  );
}

/** A "Reasoning" toggle that shows the turn's reasoning under it. */
export function ReasoningToggle({
  seat,
  turn,
  className,
  label = "Reasoning",
}: {
  readonly seat: PlayerId;
  readonly turn: number;
  readonly className?: string;
  readonly label?: string;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        className="text-primary hover:text-primary/80 flex w-fit items-center gap-1 text-xs font-medium"
      >
        {open ? (
          <ChevronDown className="size-3" aria-hidden="true" />
        ) : (
          <ChevronRight className="size-3" aria-hidden="true" />
        )}
        <Brain className="size-3" aria-hidden="true" /> {label}
      </button>
      {open ? (
        <div id={id} className="border-primary/40 ml-1 border-l-2 pl-3">
          <TurnReasoning seat={seat} turn={turn} />
        </div>
      ) : null}
    </div>
  );
}
