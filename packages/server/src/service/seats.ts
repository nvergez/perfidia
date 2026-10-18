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

/** The model and profile id an LLM controller label names (`llm:fake/claude-opus-5-5/medium:odysseus@1:p2`). */
export function parseLlmLabel(
  label: string,
): { provider: string; model: string; effort: Effort; profile: string } | null {
  const m = /^llm:([^/:]+)\/([^/:]+)\/([^/:]+):([a-z][a-z0-9-]*)@[0-9]+(?::|$)/.exec(label);
  if (m === null) return null;
  const effort = EffortSchema.safeParse(m[3]);
  if (!effort.success || m[1] === undefined || m[2] === undefined || m[4] === undefined)
    return null;
  return { provider: m[1], model: m[2], effort: effort.data, profile: m[4] };
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
        model: { provider: file.provider, model: file.model, effort: file.effort },
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
        model: { provider: llm.provider, model: llm.model, effort: llm.effort },
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
