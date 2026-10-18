import type { FeedKind } from "@perfidia/protocol/spectator";

// The colour of a moment by kind, on the scrubber and in the reel: betrayals red, fighting in warm
// tones, conquests and countdowns in gold, diplomacy in sea teal, the end in marble white.

const COLORS: Readonly<Partial<Record<FeedKind, string>>> = Object.freeze({
  betrayal: "oklch(0.63 0.21 25)",
  launch: "oklch(0.72 0.16 50)",
  battle: "oklch(0.76 0.15 65)",
  siege: "oklch(0.7 0.13 40)",
  conquest: "oklch(0.82 0.13 85)",
  countdown: "oklch(0.86 0.14 95)",
  diplomacy: "oklch(0.74 0.11 205)",
  proposal: "oklch(0.74 0.11 205)",
  answer: "oklch(0.74 0.11 205)",
  message: "oklch(0.78 0.08 240)",
  elimination: "oklch(0.6 0.02 250)",
  handoff: "oklch(0.7 0.05 300)",
  end: "oklch(0.95 0.01 250)",
});

export function momentColor(k: FeedKind, againstAlly = false): string {
  if (againstAlly) return COLORS.betrayal ?? "red";
  return COLORS[k] ?? "oklch(0.74 0.03 250)";
}

const WORDS: Readonly<Partial<Record<FeedKind, string>>> = Object.freeze({
  betrayal: "Betrayal",
  launch: "Attack launched",
  battle: "Battle",
  siege: "Siege",
  conquest: "Conquest",
  countdown: "Domination countdown",
  diplomacy: "Diplomacy",
  proposal: "Proposal",
  answer: "Answer",
  message: "Message",
  elimination: "Elimination",
  handoff: "Hand-off",
  end: "The end",
});

export function momentWord(k: FeedKind): string {
  return WORDS[k] ?? "Moment";
}
