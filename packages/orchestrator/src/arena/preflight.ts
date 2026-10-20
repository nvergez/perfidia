import type { PlayerId } from "@perfidia/protocol";
import { ENTRY_OVERHEAD_TOKENS, entryTokensUpper } from "../seat/agent.ts";
import {
  ModelError,
  type ChatRequest,
  type ModelAdapter,
  type ModelTool,
  type PreflightReport,
  type StablePrompt,
  type UsageEntry,
} from "../model/adapter.ts";
import { fallbacksOn } from "../model/anthropic.ts";
import { FALLBACK_TARGETS, costOf, formatUsd, isPriced, type Cost } from "../model/prices.ts";
import { operatorTemplates } from "../seat/prompt.ts";

// The arena's preflight (phase-2 design §2.2, §8), before the run directory exists: for each
// (provider, model, effort) group, the adapter checks the key and the model (`models.retrieve`),
// then sends the production request shape once (the group's first seat's tools and system blocks,
// a placeholder user message and the turn-header template as an operator entry, as every round 0
// sends them), which validates betas, tool schemas, `display` and mid-conversation `system`
// messages, and pre-warms the shared prefix. Every model a configured model may fall back to must
// have a price and be one of the attempt bound's targets. The same check is the pause gate's probe
// (§2.6). It cannot replay a later round (an assistant reply carries signed thinking blocks): a
// breaker whose cause only shows there trips again after its resume, which aborts the arena.
//
// Phase 4 (§5.2, §5.5): each group's outcome is reported as soon as it is known (`onGroup`), failed
// groups included with what they cost, so the arena charges it to the match budget and writes a
// `preflight` line for it; `stop` ends a probe between groups once the kill switch has fired.

/** A preflight failure: exit code 3, nothing written. */
export class PreflightError extends Error {
  override readonly name = "PreflightError";
  /** The `ModelError` kind, or `price` for an unpriced or unplanned fallback model. */
  readonly kind: string;

  constructor(kind: string, message: string) {
    super(message);
    this.kind = kind;
  }
}

/** One (provider, model, effort) group: its first seat's adapter and stable prompt. */
export interface PreflightGroup {
  readonly seat: PlayerId;
  readonly adapter: ModelAdapter;
  readonly prompt: StablePrompt;
  readonly tools: readonly ModelTool[];
}

/** What one group's check did and cost. */
export interface GroupOutcome {
  readonly group: PreflightGroup;
  readonly ok: boolean;
  readonly report: PreflightReport | null;
  /** Billed usage, failed checks included (zero when the API refused before inference). */
  readonly usage: readonly UsageEntry[];
  readonly nanoUsd: number;
  /** The platform fee part of `nanoUsd`. */
  readonly feeNanoUsd: number;
  /** The price cards charged (the requested model's first). */
  readonly cards: readonly string[];
  readonly error: {
    readonly kind: string;
    readonly status: number | null;
    readonly message: string;
  } | null;
}

export interface PreflightResult {
  readonly reports: readonly PreflightReport[];
  /** What the shape checks and pre-warms cost, in nano-dollars. */
  readonly nanoUsd: number;
  readonly groups: readonly GroupOutcome[];
  /** `stop()` ended it before every group ran. */
  readonly stopped: boolean;
}

export interface PreflightOptions {
  /** Called once per group with its outcome and cost, before the next group (or the throw). */
  readonly onGroup?: (g: GroupOutcome) => void;
  /** Checked before each group: `true` ends the preflight there (a probe after the kill switch). */
  readonly stop?: () => boolean;
  /** Prices a group's usage (its provider's cards, now); default the Claude cards. */
  readonly price?: (group: PreflightGroup, usage: readonly UsageEntry[]) => Cost;
}

/** The placeholder conversation of the shape check: a user entry, then an operator entry. */
export function sampleRequest(g: Pick<PreflightGroup, "seat" | "prompt" | "tools">): ChatRequest {
  return {
    prompt: g.prompt,
    tools: g.tools,
    entries: [
      { role: "user", parts: [{ kind: "text", text: '{"preflight":true}' }] },
      { role: "operator", text: operatorTemplates()["turnHeader"] ?? "" },
    ],
    meta: { seat: g.seat, turn: 0, round: 0, maxRounds: 1, maxCalls: 1, kind: "round" },
  };
}

const utf8 = new TextEncoder();

/**
 * An upper bound of the shape check's prompt in tokens: one token per UTF-8 byte of the prefix
 * (tools and both system blocks) and of the sample entries, plus per-block overheads.
 */
export function sampleTokensUpper(g: Pick<PreflightGroup, "seat" | "prompt" | "tools">): number {
  const req = sampleRequest(g);
  let n =
    utf8.encode(g.prompt.shared).length +
    utf8.encode(g.prompt.seat).length +
    utf8.encode(JSON.stringify(g.tools)).length +
    3 * ENTRY_OVERHEAD_TOKENS;
  for (const e of req.entries) n += entryTokensUpper(e);
  return n;
}

/** The output a preflight check may bill: Anthropic's is `max_tokens: 0`; other providers' up to 16. */
export const PREFLIGHT_OUTPUT_TOKENS = 16;

/** The group key: the adapter label, and whether the request carries server-side fallbacks. */
export const groupKey = (a: ModelAdapter): string =>
  `${a.label}|${fallbacksOn(a.spec) ? "fb" : "nofb"}`;

/** Groups seats by (provider, model, effort, fallbacks), keeping each group's first seat. */
export function groupsOf(seats: readonly PreflightGroup[]): PreflightGroup[] {
  const out = new Map<string, PreflightGroup>();
  for (const g of seats) {
    const key = groupKey(g.adapter);
    if (!out.has(key)) out.set(key, g);
  }
  return [...out.values()];
}

/** Why a group's allowed fallback models fail the plan: unpriced, or outside the attempt bound. */
function fallbackProblem(g: PreflightGroup, report: PreflightReport): string | null {
  if (!fallbacksOn(g.adapter.spec)) return null;
  const allowed = report.allowedFallbackModels;
  const unpriced = allowed.filter((m) => !isPriced(m));
  if (unpriced.length > 0) {
    return `no price for its fallback model(s) ${unpriced.join(", ")}: add them to CARDS (packages/orchestrator/src/model/prices.ts) first`;
  }
  const planned = FALLBACK_TARGETS[g.adapter.spec.model] ?? [];
  const unplanned = allowed.filter((m) => !planned.includes(m));
  if (unplanned.length > 0) {
    return `its fallback model(s) ${unplanned.join(", ")} are not in the attempt bound's targets (${planned.join(", ") || "none"}): add them to FALLBACK_TARGETS (packages/orchestrator/src/model/prices.ts), or set the seat's fallbacks to "off"`;
  }
  return null;
}

/**
 * Runs the preflight of every group, in order: each outcome goes to `onGroup` (with its cost,
 * failed groups included), then a failure throws `PreflightError`. `stop()` is checked before each
 * group and ends the run early (`stopped`).
 */
export async function preflight(
  groups: readonly PreflightGroup[],
  o: PreflightOptions = {},
): Promise<PreflightResult> {
  const reports: PreflightReport[] = [];
  const outcomes: GroupOutcome[] = [];
  let nanoUsd = 0;
  for (const g of groups) {
    if (o.stop?.() === true) return { reports, nanoUsd, groups: outcomes, stopped: true };
    const label = g.adapter.label;
    let report: PreflightReport | null = null;
    let failure: PreflightError | null = null;
    let usage: readonly UsageEntry[] = [];
    let status: number | null = null;
    try {
      // oxlint-disable-next-line no-await-in-loop -- one group at a time: a failure stops the rest
      report = await g.adapter.preflight(sampleRequest(g));
      usage = report.usage;
    } catch (e) {
      if (!(e instanceof ModelError)) throw e;
      usage = e.spent;
      status = e.status;
      const code = e.status === null ? "" : ` (${e.status})`;
      failure = new PreflightError(e.kind, `preflight of ${label}: ${e.kind}${code}: ${e.message}`);
    }
    const cost = o.price?.(g, usage) ?? costOf(usage);
    nanoUsd += cost.nanoUsd;
    if (failure === null && report !== null) {
      const problem = fallbackProblem(g, report);
      if (problem !== null)
        failure = new PreflightError("price", `preflight of ${label}: ${problem}`);
    }
    const outcome: GroupOutcome = {
      group: g,
      ok: failure === null,
      report,
      usage,
      nanoUsd: cost.nanoUsd,
      feeNanoUsd: cost.feeNanoUsd,
      cards: cost.cards,
      error: failure === null ? null : { kind: failure.kind, status, message: failure.message },
    };
    outcomes.push(outcome);
    o.onGroup?.(outcome);
    if (failure !== null) {
      throw new PreflightError(
        failure.kind,
        nanoUsd > 0
          ? `${failure.message} (the preflight spent ${formatUsd(nanoUsd)})`
          : failure.message,
      );
    }
    if (report !== null) reports.push(report);
  }
  return { reports, nanoUsd, groups: outcomes, stopped: false };
}
