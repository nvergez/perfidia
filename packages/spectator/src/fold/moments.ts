import { fmtTime } from "@perfidia/engine/core";
import type { CityId, FeedItem, Moment, Seq } from "@perfidia/protocol";

// Key moments (phase-3 design §2.7): the feed items of importance 2 or more, each with a short
// English title from a template, its players and cities, for the timeline, the reel and the story
// strip. Titles name players and cities by id (the web puts names next to ids); a betrayal and an
// attack launched against an ally carry their context. An attack fights the foe recorded at launch,
// so an attack sent to free a besieged city reads as a relief, never as an attack on its owner.

const list = (players: readonly string[]): string => players.join(", ");

/** The title of a feed item. */
export function titleOf(item: FeedItem): string {
  switch (item.k) {
    case "message":
      return `${item.from} wrote to ${item.to === "all" ? "everyone" : list(item.to)}`;
    case "proposal":
      return `${item.from} proposed ${item.kind === "alliance" ? "an alliance" : "a pact"} to ${item.to}`;
    case "answer":
      return `${item.to} ${item.accept ? "accepted" : "refused"} ${item.from}'s ${item.kind} proposal`;
    case "expired":
      return `${item.from}'s ${item.kind} proposal to ${item.to} expired`;
    case "diplomacy":
      return diplomacyTitle(item);
    case "betrayal":
      return item.relation === "ally"
        ? `${item.by} betrayed its ally ${item.against} at ${item.city}`
        : `${item.by} broke its pact with ${item.against} at ${item.city}`;
    case "launch": {
      const target = item.target === null ? "" : ` (${item.target})`;
      const lands = `, landing ${fmtTime(item.arriveAt)}`;
      const relief = item.foe !== null && item.foe !== item.target;
      const of =
        item.target === null ? "" : item.target === item.owner ? " (its own)" : ` (${item.target})`;
      if (item.againstAlly !== null) {
        const rel = item.againstAlly === "ally" ? "its ally" : "its pact partner";
        const at = relief ? `, besieging ${item.to ?? "?"}${of}` : ` at ${item.to ?? "?"}`;
        return `${item.owner} launched an attack on ${rel} ${item.foe ?? "?"}${at}${lands}`;
      }
      if (relief) {
        return `${item.owner} launched a relief of ${item.to ?? "?"}${of}, besieged by ${item.foe ?? "?"}${lands}`;
      }
      if (item.kind === "found")
        return `${item.owner} sent settlers to found a city on ${item.toIsland}`;
      if (item.settlers)
        return `${item.owner} launched a conquest of ${item.to ?? "?"}${target}${lands}`;
      return `${item.owner} launched ${item.kind === "attack" ? "an attack" : `a ${item.kind}`} on ${item.to ?? item.toIsland}${target}${lands}`;
    }
    case "battle": {
      const won = item.winner === "attacker" ? item.attacker : item.defender;
      const tail = item.fell
        ? ": the city fell"
        : item.siege === "started"
          ? ": a siege begins"
          : item.siege === "broken"
            ? ": the siege is broken"
            : "";
      return `Battle at ${item.city}: ${item.attacker} against ${item.defender}, ${won} won${tail}`;
    }
    case "siege":
      return item.event === "started"
        ? `${item.by} besieges ${item.city}${item.owner === null ? "" : ` (${item.owner})`}${item.endsAt === null ? "" : ` until ${fmtTime(item.endsAt)}`}`
        : `The siege of ${item.city} by ${item.by} is broken${item.cause === null ? "" : ` (${item.cause})`}`;
    case "conquest":
      return `${item.to} took ${item.prize ? "the prize city " : ""}${item.city}${item.from === null ? "" : ` from ${item.from}`}`;
    case "founding":
      return `${item.owner} founded ${item.city}`;
    case "spy":
      return item.event === "spy_detected"
        ? `${item.by ?? "Someone"} was caught spying on ${item.city}`
        : `${item.by ?? "Someone"} spied on ${item.city}`;
    case "elimination":
      return `${item.player} was eliminated`;
    case "countdown":
      return item.event === "started"
        ? `Domination countdown: ${item.key} (${list(item.members)}) holds ${item.cities ?? "?"} cities${item.taken === null ? "" : `, ${item.taken} taken`}${item.endsAt === null ? "" : `; wins at ${fmtTime(item.endsAt)}`}`
        : `The domination countdown of ${item.key} (${list(item.members)}) is cancelled${item.reason === null ? "" : ` (${item.reason})`}`;
    case "event":
      return item.type.replaceAll("_", " ");
    case "turn":
      return `${item.seat} played turn ${item.turn}`;
    case "handoff":
      return `${item.seat} is handed to ${item.label}`;
    case "end":
      return item.winners.length === 0
        ? `The match ended (${item.reason})`
        : `The match ended (${item.reason}): ${list(item.winners)} ${item.winners.length === 1 ? "wins" : "win"}`;
  }
  throw new Error("titleOf: unknown feed item kind");
}

function diplomacyTitle(item: Extract<FeedItem, { k: "diplomacy" }>): string {
  const [a, b] = item.players;
  switch (item.event) {
    case "alliance_formed":
      return `Alliance ${item.alliance ?? "?"}${item.name === null ? "" : ` "${item.name}"`} formed: ${list(item.players)}`;
    case "alliance_joined":
      return `${a ?? "?"} joined alliance ${item.alliance ?? "?"}`;
    case "alliance_left":
      return item.cause === "betrayal"
        ? `${a ?? "?"} left alliance ${item.alliance ?? "?"} by betrayal`
        : `${a ?? "?"} left alliance ${item.alliance ?? "?"}${item.cause === null || item.cause === "left" ? "" : ` (${item.cause})`}`;
    case "alliance_dissolved":
      return `Alliance ${item.alliance ?? "?"} dissolved`;
    case "pact_signed":
      return `${a ?? "?"} and ${b ?? "?"} signed a pact`;
    case "pact_renewed":
      return `${a ?? "?"} and ${b ?? "?"} renewed their pact`;
    case "pact_ended":
      return `The pact of ${a ?? "?"} and ${b ?? "?"} ended${item.cause === null ? "" : ` (${item.cause})`}`;
    case "pact_expired":
      return `The pact of ${a ?? "?"} and ${b ?? "?"} expired`;
  }
  throw new Error("diplomacyTitle: unknown event");
}

/** The cities an item is about. */
export function citiesOf(item: FeedItem): CityId[] {
  switch (item.k) {
    case "betrayal":
    case "battle":
    case "siege":
    case "conquest":
    case "founding":
    case "spy":
      return [item.city];
    case "launch":
      return item.to === null ? [item.from] : [item.from, item.to];
    case "message":
    case "proposal":
    case "answer":
    case "expired":
    case "diplomacy":
    case "elimination":
    case "countdown":
    case "event":
    case "turn":
    case "handoff":
    case "end":
      return [];
  }
  throw new Error("citiesOf: unknown feed item kind");
}

/** The moment of an item of importance 2 or more, else null. */
export function momentOf(item: FeedItem, seq: Seq): Moment | null {
  if (item.importance < 2) return null;
  const context = item.k === "betrayal" ? item.context : item.k === "launch" ? item.context : null;
  return {
    item: item.id,
    seq,
    t: item.t,
    k: item.k,
    importance: item.importance,
    title: titleOf(item),
    players: [...item.players],
    cities: citiesOf(item),
    ...(context === null ? {} : { context }),
  };
}
