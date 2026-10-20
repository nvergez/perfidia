import { EffortSchema, type Effort, type HeaderLine, type SeatsFile } from "@perfidia/protocol";
import type { SeatInfo } from "@perfidia/protocol/spectator";
import { cleanText } from "@perfidia/spectator";
import type { ArenaInfo } from "../store/rundir.ts";

// Who plays each seat (phase-3 design §2.6, §3.3): from the header's controller labels, `seats.json`
// (an arena run's profiles, models and hand-off bots) and `arena.json` (whether the run is fake). A
// fake seat (provider `fake`, or a `--fake` run) is flagged so the web never shows it as the model.
// Only public fields are kept: never the seat's prompt hash, cap or the shared prompts.

const capitalised = (s: string): string => (s.length === 0 ? s : s[0]?.toUpperCase() + s.slice(1));

/** `bot:opportunist@3` → `Opportunist (bot)`. */
export function botName(label: string): string {
  const m = /^bot:([a-z][a-z0-9-]*)@[0-9]+$/.exec(label);
  return m?.[1] === undefined ? cleanText(label) : `${capitalised(m[1])} (bot)`;
}

/** An escaped model or endpoint id of a label (`z-ai%2Fglm-5.3`), decoded; null when malformed. */
function decodePart(part: string): string | null {
  if (/%(?!25|2F|40)/i.test(part)) return null;
  return part.replaceAll(/%2F/gi, "/").replaceAll("%40", "@").replaceAll("%25", "%");
}

const LLM_LABEL =
  /^llm:([a-z][a-z0-9-]*)\/([^/:@\s]+)(?:@([^/:@\s]+))?\/([a-z]+):([a-z][a-z0-9-]*)@[0-9]+(?::|$)/;

/**
 * The model and profile id an LLM controller label names, phase 2's
 * (`llm:fake/claude-opus-5-5/medium:odysseus@1:p2`) and phase 4's, whose model and endpoint ids
 * escape `%`, `/` and `@` and whose prompt version may carry the channel variant
 * (`llm:openrouter/z-ai%2Fglm-5.3@z-ai%2Ffp8/medium:agamemnon@1:p2-env`).
 */
export function parseLlmLabel(label: string): {
  provider: string;
  model: string;
  endpoint: string | null;
  effort: Effort;
  profile: string;
} | null {
  const m = LLM_LABEL.exec(label);
  if (m === null) return null;
  const [, provider, rawModel, rawEndpoint, effortText, profile] = m;
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
  return { provider, model, endpoint, effort: effort.data, profile };
}

export function seatInfos(
  header: HeaderLine,
  seats: SeatsFile | null,
  arena: ArenaInfo | null,
): SeatInfo[] {
  const runFake = arena?.fake === true;
  return header.setup.seats.map((s, i): SeatInfo => {
    const label = header.controllers[s.id] ?? "";
    const color = i % 12;
    const file = seats?.seats.find((x) => x.seat === s.id);
    if (file?.kind === "llm") {
      const p = file.profile;
      return {
        seat: s.id,
        kind: "llm",
        name: cleanText(p.name.split(",")[0]?.trim() ?? p.name),
        label: cleanText(label),
        color,
        fake: runFake || file.provider === "fake",
        model: {
          provider: file.provider,
          model: file.model,
          effort: file.effort,
          ...(file.endpoint === undefined ? {} : { endpoint: file.endpoint }),
        },
        profile: {
          id: p.id,
          version: p.version,
          name: cleanText(p.name),
          goal: cleanText(p.goal),
          temperament: cleanText(p.temperament),
          word: cleanText(p.word),
          style: cleanText(p.style),
        },
        handoffBot: file.handoffBot,
      };
    }
    const llm = parseLlmLabel(label);
    if (llm !== null) {
      return {
        seat: s.id,
        kind: "llm",
        name: capitalised(llm.profile),
        label: cleanText(label),
        color,
        fake: runFake || llm.provider === "fake",
        model: {
          provider: llm.provider,
          model: llm.model,
          effort: llm.effort,
          ...(llm.endpoint === null ? {} : { endpoint: llm.endpoint }),
        },
        profile: null,
        handoffBot: null,
      };
    }
    return {
      seat: s.id,
      kind: "bot",
      name: botName(label),
      label: cleanText(label),
      color,
      fake: false,
      model: null,
      profile: null,
      handoffBot: null,
    };
  });
}
