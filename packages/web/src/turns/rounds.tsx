import {
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  CircleDashed,
  CircleHelp,
  Hourglass,
  X,
  type LucideIcon,
} from "lucide-react";
import { useId, useState } from "react";
import { PlainText } from "../common/plain-text.tsx";
import { ReasoningKindTag } from "../common/reasoning-kind.tsx";
import { cn } from "../lib/cn.ts";
import { fmtInt, fmtUsd, plural } from "../lib/format.ts";
import { shownReasoningKind, type ReasoningKind } from "../lib/models.ts";
import type { Published } from "../store/hooks.ts";
import {
  fmtLatency,
  roundTitle,
  tokenSum,
  type CallRow,
  type RoundRow,
  type Verdict,
} from "./detail.ts";

// A turn's rounds in the turn detail (phase-3 design §4.2 Pass C): per round, its reasoning
// (collapsible, labelled with what it is: a provider's summary or a raw chain of thought, the
// round's logged kind else the seat's), its reply text, and its tool calls with ✓/✗ and the rejection codes (never an
// error's text: not served), with the round's attempts, model time, cost and tokens when the
// server publishes them. Plain text only.

const VERDICT: Readonly<
  Record<Verdict, { readonly icon: LucideIcon; readonly label: string; readonly className: string }>
> = Object.freeze({
  ok: { icon: Check, label: "accepted", className: "text-emerald-400" },
  rejected: { icon: X, label: "rejected", className: "text-destructive" },
  partial: { icon: CircleDashed, label: "partly accepted", className: "text-gold" },
  pending: {
    icon: Hourglass,
    label: "verdict when the turn ends",
    className: "text-muted-foreground",
  },
  unknown: { icon: CircleHelp, label: "no log line", className: "text-muted-foreground" },
});

/** Text blocks with keys (a round's blocks never reorder; equal blocks may repeat). */
function keyed(
  xs: readonly string[],
  prefix: string,
): { readonly key: string; readonly text: string }[] {
  return xs.map((text, i) => ({ key: `${prefix}${i}`, text }));
}

function CallLine({ c }: { readonly c: CallRow }) {
  const v = VERDICT[c.verdict];
  const Icon = v.icon;
  return (
    <li
      className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 gap-y-0.5"
      data-verdict={c.verdict}
    >
      <span className={cn("inline-flex shrink-0 self-center", v.className)}>
        <Icon className="size-3.5" aria-hidden="true" />
        <span className="sr-only">{v.label}:</span>
      </span>
      <span className="font-mono text-xs break-all">{c.tool}</span>
      {c.items > 1 ? (
        <span className="text-muted-foreground text-[0.7rem]">
          {c.verdict === "pending"
            ? plural(c.items, "item")
            : `${fmtInt(c.ok)} of ${fmtInt(c.items)} items`}
        </span>
      ) : null}
      {c.implicit ? (
        <span className="text-muted-foreground text-[0.7rem]">ended the turn</span>
      ) : null}
      {c.codes.map((code) => (
        <code
          key={code}
          className="bg-destructive/15 text-destructive rounded-sm px-1 font-mono text-[0.7rem]"
        >
          {code}
        </code>
      ))}
    </li>
  );
}

function Meter({ r, published }: { readonly r: RoundRow; readonly published: Published }) {
  const m = r.meter;
  if (m === null) return null;
  const parts: string[] = [];
  if (published.costs && (m.costNanoUsd > 0 || tokenSum(m.tokens) > 0)) {
    parts.push(fmtUsd(m.costNanoUsd), `${fmtInt(tokenSum(m.tokens))} tokens`);
  }
  if (published.costs && m.latencyMs > 0) parts.push(fmtLatency(m.latencyMs));
  if (m.attempts > 1) parts.push(`${fmtInt(m.attempts)} attempts`);
  if (m.stop !== null && m.stop !== "tool_use" && m.stop !== "end_turn")
    parts.push(`stop: ${m.stop}`);
  return parts.length === 0 ? null : (
    <span className="text-muted-foreground font-normal tracking-normal normal-case">
      {parts.join(" · ")}
    </span>
  );
}

function Round({
  r,
  open,
  onToggle,
  published,
  live,
  seatKind,
}: {
  readonly r: RoundRow;
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly published: Published;
  readonly live: boolean;
  readonly seatKind: ReasoningKind | null;
}) {
  const id = useId();
  const hasReasoning = r.reasoning.length > 0;
  const kind = shownReasoningKind(r.reasoningKind, seatKind);
  return (
    <li
      className={cn(
        "bg-card flex flex-col gap-1.5 rounded-md border p-2.5",
        live && "motion-safe:animate-in motion-safe:fade-in-0",
      )}
      data-round={r.key}
    >
      <h4 className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[0.7rem] font-semibold tracking-wider uppercase">
        <span>{roundTitle(r)}</span>
        <Meter r={r} published={published} />
        {r.meter?.refusal === null || r.meter?.refusal === undefined ? null : (
          <span className="text-destructive normal-case">
            refused (<bdi>{r.meter.refusal}</bdi>)
          </span>
        )}
        {r.meter === null || r.meter.errors.length === 0 ? null : (
          <span className="text-destructive font-normal tracking-normal normal-case">
            {plural(r.meter.errors.length, "failed attempt")}:{" "}
            <bdi>{r.meter.errors.join(", ")}</bdi>
          </span>
        )}
      </h4>
      {hasReasoning ? (
        <div className="flex flex-col gap-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              aria-expanded={open}
              aria-controls={id}
              onClick={onToggle}
              className="text-primary hover:text-primary/80 flex w-fit items-center gap-1 text-xs font-medium"
            >
              {open ? (
                <ChevronDown className="size-3" aria-hidden="true" />
              ) : (
                <ChevronRight className="size-3" aria-hidden="true" />
              )}
              <Brain className="size-3" aria-hidden="true" /> Reasoning
            </button>
            <ReasoningKindTag kind={kind} />
          </div>
          {open ? (
            <div id={id} className="border-primary/40 flex flex-col gap-1 border-l-2 pl-2.5">
              {keyed(r.reasoning, "r").map((b) => (
                <PlainText
                  key={b.key}
                  text={b.text}
                  className="text-foreground/90 block text-sm italic"
                />
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
      {keyed(r.text, "t").map((b) => (
        <PlainText key={b.key} text={b.text} className="block text-sm" />
      ))}
      {r.calls.length === 0 ? (
        <p className="text-muted-foreground text-xs">No tool call.</p>
      ) : (
        <ul className="flex flex-col gap-1" aria-label={`Tool calls of ${roundTitle(r)}`}>
          {r.calls.map((c) => (
            <CallLine key={c.key} c={c} />
          ))}
        </ul>
      )}
    </li>
  );
}

/** A turn's rounds; reasoning open by default, each collapsible, all at once too. */
export function RoundList({
  rounds,
  published,
  live = false,
  seatKind = null,
}: {
  readonly rounds: readonly RoundRow[];
  readonly published: Published;
  /** Rounds arrive while it is shown (an open turn): new ones fade in (motion allowed). */
  readonly live?: boolean;
  /** What the seat's reasoning is expected to be (a round's logged kind wins). */
  readonly seatKind?: ReasoningKind | null;
}) {
  const [closed, setClosed] = useState<ReadonlySet<string>>(() => new Set());
  const any = rounds.some((r) => r.reasoning.length > 0);
  const allClosed = any && rounds.every((r) => r.reasoning.length === 0 || closed.has(r.key));
  return (
    <div className="flex flex-col gap-2">
      {any ? (
        <button
          type="button"
          onClick={() => setClosed(allClosed ? new Set() : new Set(rounds.map((r) => r.key)))}
          className="text-muted-foreground hover:text-foreground w-fit text-xs"
        >
          {allClosed ? "Show all reasoning" : "Hide all reasoning"}
        </button>
      ) : null}
      <ol className="flex flex-col gap-2">
        {rounds.map((r) => (
          <Round
            key={r.key}
            r={r}
            open={!closed.has(r.key)}
            onToggle={() => {
              const next = new Set(closed);
              if (next.has(r.key)) next.delete(r.key);
              else next.add(r.key);
              setClosed(next);
            }}
            published={published}
            live={live}
            seatKind={seatKind}
          />
        ))}
      </ol>
    </div>
  );
}
