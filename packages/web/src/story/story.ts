import type {
  FeedItem,
  FeedItemOf,
  Frame,
  FrameResult,
  Moment,
  Standing,
} from "@perfidia/protocol/spectator";
import { findEntry } from "../feed/filter.ts";
import { fmtInt } from "../lib/format.ts";
import { DAY, HOUR, MINUTE, fmtAgo, fmtSpan, fmtTime } from "../lib/time.ts";
import type { FeedEntry } from "../playback/timeline.ts";
import type { DominationBloc, DominationCountdown, DominationView } from "../skins/index.ts";

// The story strip (phase-3 design §4.3): one line that answers "who is winning, by how much, how
// close is a bloc to winning, and who betrayed whom", filled from the frame and the moments by
// templates (not a narrator). Pure: it returns parts (text, players, alliance names, times) that
// the strip renders with names and ids, and `storyText` spells them for tests.
//   "Day 5, 14:20 · Odysseus · p1 leads with 1,312, 52 ahead of Achilles · p2 · War p1 (p1, p4)
//    holds 14 of 16 cities, 1 of 2 taken · Last betrayal: Achilles · p2 attacked its ally
//    Penelope · p3 at c18, 3 h ago"
// While an attack on an ally is in flight, the last part reads "Achilles · p2 has launched an
// attack on its ally Penelope · p3; it lands at D4 12:50 (in 13 h)".

export type StoryPart =
  | { readonly k: "text"; readonly text: string }
  | { readonly k: "strong"; readonly text: string }
  | { readonly k: "player"; readonly id: string }
  /** An alliance's name: player-authored text. */
  | { readonly k: "alliance"; readonly name: string }
  | { readonly k: "time"; readonly t: number }
  /** A bloc member: its glyph and id only (the bloc is named before). */
  | { readonly k: "member"; readonly id: string }
  /** " (in 3 h)" until game time `at`, from the playhead (the strip keeps it live). */
  | { readonly k: "left"; readonly at: number; readonly from: number };

/** One sentence of the strip; the strip separates them with " · ". */
export interface StorySentence {
  readonly key: "clock" | "leader" | "bloc" | "irony";
  /** The irony sentence is a betrayal (red) or an attack on an ally in flight (red, pulsing). */
  readonly tone: "plain" | "betrayal" | "danger";
  readonly parts: readonly StoryPart[];
}

export interface StoryInput {
  /** The time shown (the playhead, or the frame's time). */
  readonly t: number;
  readonly standings: readonly Standing[];
  readonly result: FrameResult | null;
  readonly domination: DominationView | null;
  readonly alliances: Frame["alliances"];
  readonly movements: Frame["movements"];
  /** Moments up to the frame shown. */
  readonly moments: readonly Moment[];
  /** Feed entries up to the frame shown (to read the items behind the moments). */
  readonly feed: readonly FeedEntry[];
}

const text = (s: string): StoryPart => ({ k: "text", text: s });
const player = (id: string): StoryPart => ({ k: "player", id });

/** "Day 5, 14:20". */
export function storyClock(t: number): string {
  const s = Math.max(0, Math.floor(t));
  const second = s % DAY;
  const hh = Math.floor(second / HOUR);
  const mm = Math.floor((second % HOUR) / MINUTE);
  return `Day ${Math.floor(s / DAY) + 1}, ${hh < 10 ? `0${hh}` : hh}:${mm < 10 ? `0${mm}` : mm}`;
}

/** Players joined in prose: "p1", "p1 and p4", "p1, p4 and p5". */
export function joinPlayers(ids: readonly string[]): StoryPart[] {
  const out: StoryPart[] = [];
  ids.forEach((id, i) => {
    if (i > 0) out.push(text(i === ids.length - 1 ? " and " : ", "));
    out.push(player(id));
  });
  return out;
}

const RESULT_WORDS: Readonly<Record<string, string>> = Object.freeze({
  domination: "by domination",
  time: "on points at the end",
  last_standing: "as the last one standing",
});

function leaderSentence(input: StoryInput): StorySentence | null {
  const { result, standings } = input;
  if (result !== null) {
    const how = RESULT_WORDS[result.reason] ?? `(${result.reason.replaceAll("_", " ")})`;
    if (result.winners.length === 0) {
      return { key: "leader", tone: "plain", parts: [text(`The match is over ${how}: no winner`)] };
    }
    return {
      key: "leader",
      tone: "plain",
      parts: [
        text("The match is over: "),
        ...joinPlayers(result.winners),
        text(` ${result.winners.length === 1 ? "wins" : "win"} ${how}`),
      ],
    };
  }
  const alive = standings.filter((s) => s.alive);
  const first = alive[0];
  if (first === undefined) return null;
  const second = alive[1];
  const parts: StoryPart[] = [player(first.player), text(` leads with ${fmtInt(first.score)}`)];
  if (second !== undefined) {
    const gap = first.score - second.score;
    parts.push(
      text(gap === 0 ? ", tied with " : `, ${fmtInt(gap)} ahead of `),
      player(second.player),
    );
  }
  return { key: "leader", tone: "plain", parts };
}

/** A bloc named in prose: "War p1 (p1, p4)" for an alliance, the player for a lone one. */
export function blocParts(
  key: string,
  members: readonly string[],
  alliances: Frame["alliances"],
): StoryPart[] {
  const alliance = Object.values(alliances).find((a) => a?.id === key) ?? null;
  if (alliance === null) {
    return members.length === 1
      ? joinPlayers(members)
      : [text("the bloc of "), ...joinPlayers(members)];
  }
  const ids: StoryPart[] = [];
  members.forEach((id, i) => {
    if (i > 0) ids.push(text(", "));
    ids.push({ k: "member", id });
  });
  return [{ k: "alliance", name: alliance.name }, text(" ("), ...ids, text(")")];
}

/** The bloc closest to a domination win: most cities, then most taken. */
export function leadingBloc(d: DominationView): DominationBloc | null {
  let best: DominationBloc | null = null;
  for (const b of d.blocs) {
    if (
      best === null ||
      b.cities > best.cities ||
      (b.cities === best.cities && b.taken > best.taken)
    ) {
      best = b;
    }
  }
  return best;
}

function countdownSentence(
  c: DominationCountdown,
  t: number,
  alliances: Frame["alliances"],
): StorySentence {
  const parts: StoryPart[] = [...blocParts(c.key, c.members, alliances)];
  parts.push(text(` holds ${c.cities === null ? "enough" : fmtInt(c.cities)} cities`));
  if (c.taken !== null) parts.push(text(`, ${fmtInt(c.taken)} taken`));
  if (c.endsAt === null) {
    parts.push(text(": a domination countdown is running"));
  } else {
    parts.push(text(": wins at "), { k: "time", t: c.endsAt });
    if (c.endsAt > t) parts.push({ k: "left", at: c.endsAt, from: t });
    parts.push(text(" if it holds"));
  }
  return { key: "bloc", tone: "plain", parts };
}

function blocSentence(input: StoryInput): StorySentence | null {
  const d = input.domination;
  if (d === null || input.result !== null) return null;
  // Too short a match for a countdown to finish: domination cannot decide it.
  if (d.opensAt !== null && d.startBy !== null && d.startBy < d.opensAt) return null;
  const running = d.countdowns[0];
  if (running !== undefined) return countdownSentence(running, input.t, input.alliances);
  const b = leadingBloc(d);
  if (b === null || d.need === null) return null;
  const tied = d.blocs.filter((x) => x.cities === b.cities && x.taken === b.taken).length > 1;
  const parts: StoryPart[] = tied
    ? [
        text(
          `No bloc leads: each holds at most ${fmtInt(b.cities)} of the ${fmtInt(d.need)} cities a win needs`,
        ),
      ]
    : [
        ...blocParts(b.key, b.members, input.alliances),
        text(` holds ${fmtInt(b.cities)} of the ${fmtInt(d.need)} cities a win needs`),
      ];
  if (!tied && d.needTaken !== null && d.needTaken > 0) {
    parts.push(text(`, ${fmtInt(Math.min(b.taken, d.needTaken))} of ${fmtInt(d.needTaken)} taken`));
  }
  if (!d.open && d.opensAt !== null && d.opensAt > input.t) {
    parts.push(text(" (domination opens at "), { k: "time", t: d.opensAt }, text(")"));
  }
  return { key: "bloc", tone: "plain", parts };
}

type Launch = FeedItemOf<"launch">;
type Betrayal = FeedItemOf<"betrayal">;

/** The item behind a moment, from the feed (null when not held). */
function itemOf(feed: readonly FeedEntry[], m: Moment): FeedItem | null {
  return findEntry(feed, m.seq, m.item)?.item ?? null;
}

/** The latest attack on an ally still at sea at time `t` (its movement is in the frame). */
export function attackOnAllyInFlight(input: StoryInput): Launch | null {
  for (let i = input.moments.length - 1; i >= 0; i -= 1) {
    const m = input.moments[i];
    if (m === undefined || m.k !== "launch" || m.importance < 3) continue;
    const item = itemOf(input.feed, m);
    if (item?.k !== "launch" || item.againstAlly === null) continue;
    if (item.arriveAt > input.t && Object.hasOwn(input.movements, item.movement)) return item;
  }
  return null;
}

/** The latest betrayal up to the frame. */
export function lastBetrayal(input: StoryInput): Betrayal | null {
  for (let i = input.moments.length - 1; i >= 0; i -= 1) {
    const m = input.moments[i];
    if (m === undefined || m.k !== "betrayal") continue;
    const item = itemOf(input.feed, m);
    if (item?.k === "betrayal") return item;
  }
  return null;
}

const relationWords = (r: "ally" | "pact"): string =>
  r === "ally" ? "its ally" : "its pact partner";

function ironySentence(input: StoryInput): StorySentence | null {
  const launch = attackOnAllyInFlight(input);
  if (launch !== null && launch.againstAlly !== null) {
    const foe = launch.foe ?? launch.target;
    return {
      key: "irony",
      tone: "danger",
      parts: [
        player(launch.owner),
        text(` has launched an attack on ${relationWords(launch.againstAlly)} `),
        ...(foe === null ? [text("?")] : [player(foe)]),
        text("; it lands at "),
        { k: "time", t: launch.arriveAt },
        { k: "left", at: launch.arriveAt, from: input.t },
      ],
    };
  }
  const b = lastBetrayal(input);
  if (b !== null) {
    const verb =
      b.relation === "ally"
        ? [text(" attacked its ally "), player(b.against)]
        : [text(" broke its pact with "), player(b.against)];
    return {
      key: "irony",
      tone: "betrayal",
      parts: [
        { k: "strong", text: "Last betrayal: " },
        player(b.by),
        ...verb,
        text(` at ${b.city}, ${fmtAgo(input.t - b.t)}`),
      ],
    };
  }
  const latest = input.moments.findLast((m) => m.importance >= 3) ?? input.moments.at(-1);
  if (latest === undefined) return null;
  return {
    key: "irony",
    tone: "plain",
    parts: [
      { k: "strong", text: "Latest: " },
      text(`${latest.title}, ${fmtAgo(input.t - latest.t)}`),
    ],
  };
}

/** The strip's sentences, in order. */
export function buildStory(input: StoryInput): StorySentence[] {
  const out: StorySentence[] = [
    { key: "clock", tone: "plain", parts: [{ k: "strong", text: storyClock(input.t) }] },
  ];
  for (const s of [leaderSentence(input), blocSentence(input), ironySentence(input)]) {
    if (s !== null) out.push(s);
  }
  return out;
}

/** The strip as text, players named by `label` ("Odysseus · p1"). */
export function storyText(
  sentences: readonly StorySentence[],
  label: (id: string) => string,
): string {
  return sentences
    .map((s) =>
      s.parts
        .map((p) => {
          switch (p.k) {
            case "text":
            case "strong":
              return p.text;
            case "player":
              return label(p.id);
            case "alliance":
              return p.name;
            case "time":
              return fmtTime(p.t);
            case "member":
              return p.id;
            case "left":
              return p.at > p.from ? ` (in ${fmtSpan(p.at - p.from)})` : "";
          }
          throw new Error("storyText: unknown part");
        })
        .join(""),
    )
    .join(" · ");
}
