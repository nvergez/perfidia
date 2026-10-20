import {
  EffortSchema,
  type Effort,
  type PromptVariant,
  type StatsGrouping,
} from "@perfidia/protocol";

// The item keys and ids of per-model statistics (phase-4 design §6.2): an LLM seat is keyed by the
// model it started on, `provider/model[@endpoint]/effort` (a fake seat under provider `fake`, so a
// bot behind the LLM pipe never counts as the model it mirrors), a bot by its label. Ids are the keys
// as URL path segments: lowercase letters and digits, runs of anything else as `-`, parts joined by
// `.` (`openrouter.z-ai-glm-5-3.z-ai-fp8.low`, `bot.conqueror.3`). Labels are parsed as the
// orchestrator writes them: model and endpoint ids escape `%`, `/` and `@` (`%25`, `%2F`, `%40`), the
// prompt version may carry the operator channel (`-dev`, `-env`).

export interface LabelModel {
  readonly provider: string;
  readonly model: string;
  readonly endpoint: string | null;
  readonly effort: Effort;
  /** `odysseus@1`. */
  readonly profile: string;
  readonly variant: PromptVariant;
}

const LLM_LABEL =
  /^llm:([a-z][a-z0-9-]*)\/([^/:@\s]+)(?:@([^/:@\s]+))?\/([a-z]+):([a-z][a-z0-9-]*@[0-9]+):p[0-9]+(-dev|-env)?$/;

/** An escaped model or endpoint id of a label, decoded; null when malformed. */
function decodePart(part: string): string | null {
  if (/%(?!25|2F|40)/i.test(part)) return null;
  return part.replaceAll(/%2F/gi, "/").replaceAll("%40", "@").replaceAll("%25", "%");
}

/** The model, profile and channel an LLM controller label names; null for any other label. */
export function parseLabel(label: string): LabelModel | null {
  const m = LLM_LABEL.exec(label);
  if (m === null) return null;
  const [, provider, rawModel, rawEndpoint, effortText, profile, suffix] = m;
  const effort = EffortSchema.safeParse(effortText);
  const model = rawModel === undefined ? null : decodePart(rawModel);
  const endpoint = rawEndpoint === undefined ? null : decodePart(rawEndpoint);
  if (
    !effort.success ||
    provider === undefined ||
    model === null ||
    (rawEndpoint !== undefined && endpoint === null) ||
    profile === undefined
  ) {
    return null;
  }
  return {
    provider,
    model,
    endpoint,
    effort: effort.data,
    profile,
    variant: suffix === "-dev" ? "developer" : suffix === "-env" ? "envelope" : "system",
  };
}

/** `provider/model[@endpoint]/effort`. */
export function modelKey(m: {
  readonly provider: string;
  readonly model: string;
  readonly endpoint: string | null;
  readonly effort: string;
}): string {
  return `${m.provider}/${m.model}${m.endpoint === null ? "" : `@${m.endpoint}`}/${m.effort}`;
}

/** A part of an id: lowercase letters and digits, every other run as one `-`, trimmed. */
export function idPart(text: string): string {
  const out = text
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "");
  return out === "" ? "x" : out;
}

/** The id of a model key's parts. */
export function modelIdOf(m: {
  readonly provider: string;
  readonly model: string;
  readonly endpoint: string | null;
  readonly effort: string;
}): string {
  const parts = [m.provider, m.model, ...(m.endpoint === null ? [] : [m.endpoint]), m.effort];
  return parts.map(idPart).join(".");
}

/** `bot:conqueror@3` → `bot.conqueror.3`; any other label → `bot.<label>`. */
export function botIdOf(label: string): string {
  const m = /^bot:([a-z][a-z0-9-]*)(?:@([0-9]+))?$/.exec(label);
  if (m?.[1] === undefined) return `bot.${idPart(label.replace(/^bot:/, ""))}`;
  return m[2] === undefined ? `bot.${idPart(m[1])}` : `bot.${idPart(m[1])}.${m[2]}`;
}

/** `odysseus@1` → `odysseus.1`. */
export function profileIdOf(profile: string): string {
  const at = profile.lastIndexOf("@");
  return at < 0
    ? idPart(profile)
    : `${idPart(profile.slice(0, at))}.${idPart(profile.slice(at + 1))}`;
}

/** What a seat is grouped by, as it started. */
export interface SeatKeyParts {
  readonly kind: "llm" | "bot";
  /** The model key (LLM) or the bot's label. */
  readonly key: string;
  readonly id: string;
  readonly profile: string | null;
  readonly variant: PromptVariant | null;
}

/**
 * A seat's item under a grouping: its model (default), its profile, its prompt variant, or its model
 * × profile. Bot seats are their bot under every grouping (bots are ordinary items, design §6.2).
 */
export function itemOf(s: SeatKeyParts, grouping: StatsGrouping): { key: string; id: string } {
  if (s.kind === "bot" || grouping === "model") return { key: s.key, id: s.id };
  if (grouping === "profile") {
    return s.profile === null
      ? { key: "profile:unknown", id: "profile.unknown" }
      : { key: `profile:${s.profile}`, id: `profile.${profileIdOf(s.profile)}` };
  }
  if (grouping === "variant") {
    const v = s.variant ?? "system";
    return { key: `variant:${v}`, id: `variant.${v}` };
  }
  const p = s.profile ?? "unknown";
  return { key: `${s.key} as ${p}`, id: `${s.id}.as.${profileIdOf(p)}` };
}
