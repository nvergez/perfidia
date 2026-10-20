import { cn } from "../lib/cn.ts";
import { reasoningKindHint, reasoningKindTitle, type ReasoningKind } from "../lib/models.ts";

// What a reasoning text is (phase-4 design §3.2 item 4): a summary the provider wrote of hidden
// reasoning, or a model's raw chain of thought (open models such as GLM). Reasoning text is never
// shown without it; the tooltip says what the kind means. Raw text is marked in gold.

export function ReasoningKindTag({
  kind,
  className,
}: {
  readonly kind: ReasoningKind | null;
  readonly className?: string;
}) {
  if (kind === null) return null;
  return (
    <span
      data-reasoning-kind={kind}
      title={reasoningKindHint(kind)}
      className={cn(
        "inline-flex w-fit shrink-0 items-center rounded-sm border px-1 text-[0.65rem] leading-4 font-medium tracking-normal normal-case not-italic",
        kind === "raw" ? "border-gold/60 text-gold" : "text-muted-foreground border-border",
        className,
      )}
    >
      {reasoningKindTitle(kind)}
    </span>
  );
}
