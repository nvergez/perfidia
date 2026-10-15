import type { PlayerId } from "@perfidia/protocol";
import {
  ModelError,
  type ChatRequest,
  type ModelAdapter,
  type ModelTool,
  type PreflightReport,
  type StablePrompt,
} from "../model/adapter.ts";
import { costOf, isPriced } from "../model/prices.ts";

// The arena's preflight (phase-2 design §2.2, §8), before the run directory exists: for each
// (provider, model, effort) group, the adapter checks the key and the model (`models.retrieve`),
// then sends the exact production request shape once (the group's first seat's tools and system
// blocks, a placeholder user message), which validates betas, tool schemas and `display` and
// pre-warms the shared prefix. Every model a configured model may fall back to must have a price.
// The same check is the pause gate's probe (§2.6).

/** A preflight failure: exit code 3, nothing written. */
export class PreflightError extends Error {
  override readonly name = "PreflightError";
  /** The `ModelError` kind, or `price` for an unpriced fallback model. */
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

export interface PreflightResult {
  readonly reports: readonly PreflightReport[];
  /** What the shape checks and pre-warms cost, in nano-dollars. */
  readonly nanoUsd: number;
}

/** The placeholder conversation of the shape check: game data only, as every user turn. */
export function sampleRequest(g: PreflightGroup): ChatRequest {
  return {
    prompt: g.prompt,
    tools: g.tools,
    entries: [{ role: "user", parts: [{ kind: "text", text: '{"preflight":true}' }] }],
    meta: { seat: g.seat, turn: 0, round: 0, maxRounds: 1, maxCalls: 1, kind: "round" },
  };
}

/** Groups seats by (provider, model, effort), keeping each group's first seat. */
export function groupsOf(seats: readonly PreflightGroup[]): PreflightGroup[] {
  const out = new Map<string, PreflightGroup>();
  for (const g of seats) {
    const s = g.adapter.spec;
    const key = `${s.provider}/${s.model}/${s.effort}`;
    if (!out.has(key)) out.set(key, g);
  }
  return [...out.values()];
}

/** Runs the preflight of every group, in order; throws `PreflightError` on the first failure. */
export async function preflight(groups: readonly PreflightGroup[]): Promise<PreflightResult> {
  const reports: PreflightReport[] = [];
  let nanoUsd = 0;
  for (const g of groups) {
    const label = g.adapter.label;
    let report: PreflightReport;
    try {
      // oxlint-disable-next-line no-await-in-loop -- one group at a time: a failure stops the rest
      report = await g.adapter.preflight(sampleRequest(g));
    } catch (e) {
      if (e instanceof ModelError) {
        const status = e.status === null ? "" : ` (${e.status})`;
        throw new PreflightError(e.kind, `preflight of ${label}: ${e.kind}${status}: ${e.message}`);
      }
      throw e;
    }
    const unpriced = report.allowedFallbackModels.filter((m) => !isPriced(m));
    if (unpriced.length > 0) {
      throw new PreflightError(
        "price",
        `preflight of ${label}: no price for its fallback model(s) ${unpriced.join(", ")}: add them to PRICES (packages/orchestrator/src/model/prices.ts) first`,
      );
    }
    nanoUsd += costOf(report.usage).nanoUsd;
    reports.push(report);
  }
  return { reports, nanoUsd };
}
