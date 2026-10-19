import { EyeOff } from "lucide-react";
import { cn } from "../lib/cn.ts";

// What the server does not publish for a match (`MatchMeta.published`, its `--no-costs` and
// `--no-reasoning`): one short line in place of the figures or text, never an empty box.

export function NotPublished({
  what,
  className,
}: {
  /** "Reasoning", "Costs": the sentence's subject. */
  readonly what: string;
  readonly className?: string;
}) {
  return (
    <p
      data-not-published=""
      className={cn("text-muted-foreground flex items-center gap-1.5 text-xs", className)}
    >
      <EyeOff className="size-3 shrink-0" aria-hidden="true" />
      {what} not published for this match.
    </p>
  );
}
