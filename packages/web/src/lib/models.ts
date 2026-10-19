import type { SeatInfo } from "@perfidia/protocol/spectator";

// Model names for display (phase-3 design §4.5): `claude-opus-5-5` reads "Opus 5.5"; an unknown id
// shows as it is. A fake seat (provider `fake`, or a `--fake` run: a bot behind the LLM pipe)
// always reads "Fake", never the model it stands in for.

const KNOWN: Readonly<Record<string, string>> = Object.freeze({
  "claude-opus-5-5": "Opus 5.5",
});

const FAMILY = /^claude-(opus|sonnet|haiku)-([0-9]+)(?:-([0-9]+))?(?:-[0-9]{8})?$/;

/** A model id's display name: known names, then `claude-<family>-<major>-<minor>`, else the id. */
export function modelName(model: string): string {
  const known = KNOWN[model];
  if (known !== undefined) return known;
  const m = FAMILY.exec(model);
  if (m === null) return model;
  const family = m[1] ?? "";
  const version = m[3] === undefined ? (m[2] ?? "") : `${m[2] ?? ""}.${m[3]}`;
  return `${family.charAt(0).toUpperCase()}${family.slice(1)} ${version}`;
}

type SeatKind = Pick<SeatInfo, "kind" | "fake" | "model">;

/** A seat played by a bot behind the LLM pipe: never shown as the model. */
export function isFakeSeat(seat: SeatKind): boolean {
  return seat.fake || seat.model?.provider === "fake";
}

/** The model badge of a seat: "Opus 5.5 · medium", "Bot" or "Fake". */
export function modelLabel(seat: SeatKind): string {
  if (isFakeSeat(seat)) return "Fake";
  if (seat.kind === "bot") return "Bot";
  if (seat.model === null) return "LLM";
  return `${modelName(seat.model.model)} · ${seat.model.effort}`;
}

/** A longer description of who plays a seat, for tooltips and the dossier. */
export function playedBy(seat: SeatKind): string {
  if (isFakeSeat(seat)) return "Fake model: a scripted bot behind the LLM pipe";
  if (seat.kind === "bot") return "Scripted bot";
  if (seat.model === null) return "Language model";
  return `${modelName(seat.model.model)} (${seat.model.provider}), effort ${seat.model.effort}`;
}
