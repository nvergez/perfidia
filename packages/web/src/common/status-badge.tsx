import type { MatchStatus, PublicReason } from "@perfidia/protocol/spectator";
import { cn } from "../lib/cn.ts";
import { Badge } from "../ui/badge.tsx";

// A match's status in a fixed public wording (never operator text).

const WORDS: Readonly<Record<MatchStatus, string>> = Object.freeze({
  loading: "Loading",
  live: "Live",
  paused: "Paused",
  stalled: "Stalled",
  ended: "Ended",
  stopped: "Stopped",
  degraded: "Degraded",
  aborted: "Aborted",
  fatal: "Engine error",
  incomplete: "Incomplete",
  unverifiable: "Unverifiable",
  unpublished: "Taken down",
});

const REASONS: Readonly<Record<PublicReason, string>> = Object.freeze({
  domination: "by domination",
  time: "on time",
  last_standing: "last one standing",
  stopped_after_day: "stopped after a day",
  aborted: "aborted",
  engine_error: "engine error",
  model_errors: "many model turns failed",
  operator_pause: "paused by the operator",
  unverifiable: "the log does not verify",
});

export function statusWord(status: MatchStatus): string {
  return WORDS[status];
}

export function reasonWords(reason: PublicReason | null): string | null {
  return reason === null ? null : REASONS[reason];
}

export function StatusBadge({
  status,
  className,
}: {
  readonly status: MatchStatus;
  readonly className?: string;
}) {
  if (status === "live") {
    return (
      <Badge className={cn("bg-live text-white uppercase tracking-wide", className)}>
        <span
          className="size-1.5 rounded-full bg-white motion-safe:animate-pulse"
          aria-hidden="true"
        />
        Live
      </Badge>
    );
  }
  const bad = status === "unverifiable" || status === "fatal" || status === "aborted";
  return (
    <Badge
      variant={bad ? "destructive" : "secondary"}
      className={cn("uppercase tracking-wide", className)}
    >
      {WORDS[status]}
    </Badge>
  );
}

/** The FAKE badge of a run whose LLM seats are bots behind the LLM pipe. */
export function FakeBadge({ className }: { readonly className?: string }) {
  return (
    <Badge
      variant="outline"
      title="Fake models: scripted bots stand in for the language models"
      className={cn("border-gold/70 text-gold uppercase tracking-wide", className)}
    >
      Fake
    </Badge>
  );
}
