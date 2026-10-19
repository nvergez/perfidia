import type { TurnAnnotation } from "@perfidia/protocol/spectator";
import { Loader2, RefreshCw } from "lucide-react";
import { NotPublished } from "../common/not-published.tsx";
import { PlainText } from "../common/plain-text.tsx";
import type { PlayerId } from "../lib/ids.ts";
import { fmtUsd, plural } from "../lib/format.ts";
import { isFakeSeat } from "../lib/models.ts";
import { useAnnotation, usePublished, useSeat, type Published } from "../store/hooks.ts";
import { loaders } from "../store/session.ts";
import { Button } from "../ui/button.tsx";

// A turn's reasoning (phase-3 design §4.3 "Thoughts", §2.7 annotations): the reasoning summaries
// and reply text of each round, with the tools it called, fetched from the annotations route when
// the viewer opens it. Reasoning is model-authored text: plain text only. A chunk loaded on demand
// (`thoughts/lazy.ts`); the full turn detail is `turns/` (Pass C).

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

function Rounds({
  a,
  fake,
  published,
}: {
  readonly a: TurnAnnotation;
  readonly fake: boolean;
  readonly published: Published;
}) {
  const any = a.rounds.some((r) => r.reasoning.length > 0 || r.text.length > 0);
  const cost = turnCost(a);
  return (
    <div className="flex flex-col gap-2">
      {!published.reasoning ? (
        <NotPublished what="Reasoning" />
      ) : any ? null : (
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
      {!published.costs ? (
        <NotPublished what="Costs" />
      ) : cost === 0 && a.spentNanoUsd === null ? null : (
        <p className="text-muted-foreground text-xs">
          {cost === 0 ? null : <>This turn cost {fmtUsd(cost)}. </>}
          {a.spentNanoUsd === null ? null : (
            <>
              Spent so far {fmtUsd(a.spentNanoUsd)}
              {a.capNanoUsd === null ? null : <> of a {fmtUsd(a.capNanoUsd)} cap</>}.
            </>
          )}
          {fake ? " (Simulated prices: a fake model costs nothing.)" : null}
        </p>
      )}
    </div>
  );
}

/** The reasoning of turn `turn` of `seat`, loaded when shown. */
export function TurnReasoning({ seat, turn }: { readonly seat: PlayerId; readonly turn: number }) {
  const a = useAnnotation(seat, turn, true);
  const info = useSeat(seat);
  const fake = info !== null && isFakeSeat(info);
  const published = usePublished();
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
      <Rounds a={a.value} fake={fake} published={published} />
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
