import type { FeedItem, FeedItemOf } from "@perfidia/protocol/spectator";
import {
  Bell,
  Bot,
  Brain,
  Castle,
  Crown,
  Eye,
  Flag,
  Handshake,
  HeartCrack,
  Hourglass,
  Lock,
  Mail,
  Megaphone,
  Ship,
  Skull,
  Swords,
  Tent,
  Trophy,
  type LucideIcon,
} from "lucide-react";
import { memo, type ReactNode } from "react";
import { GameTime } from "../common/game-time.tsx";
import { PlainText } from "../common/plain-text.tsx";
import { fmtInt, plural } from "../lib/format.ts";
import type { FeedEntry } from "../playback/timeline.ts";
import { useFeed, useMatch, useSeatColor, useSkin } from "../store/hooks.ts";
import { ReasoningToggle } from "../thoughts/reasoning.tsx";
import { OpenTurnButton } from "../turns/open-turn.tsx";
import { BetrayalCard } from "./betrayal-card.tsx";
import { CityRef, TimeLeft, Who, WhoList, unitsText } from "./bits.tsx";
import { allianceNamesOf, sameTurnOf, seenBy } from "./filter.ts";
import { BattleReport } from "./report.tsx";
import { LongText, Shell, type Tone } from "./shell.tsx";
import { SameTurnThought } from "./thought.tsx";

// The feed's cards (phase-3 design §4.3 "Feed"): one per item, in the words an outsider reads.
// Messages show their sender's colour, a lock and who saw them, the full text, and the sender's
// same-turn thought; betrayals and attacks launched on an ally get the large red card. Clicking a
// card (or its time) moves the playhead just after its log line. Player text is plain text only.

function MessageCard({
  entry,
  selected,
}: {
  readonly entry: FeedEntry;
  readonly selected: boolean;
}) {
  const item = entry.item;
  const color = useSeatColor(item.k === "message" ? item.from : null);
  if (item.k !== "message") return null;
  const seen = seenBy(item);
  const same = sameTurnOf(item);
  return (
    <Shell
      entry={entry}
      icon={item.private ? Mail : Megaphone}
      kind={item.private ? "Private message" : "Message to everyone"}
      accent={color}
      selected={selected}
    >
      <p className="leading-snug">
        <Who id={item.from} /> <span className="text-muted-foreground">to</span>{" "}
        {item.to === "all" ? <strong>everyone</strong> : <WhoList ids={item.to} />}
      </p>
      {seen === "all" ? null : (
        <p className="text-muted-foreground mt-0.5 flex items-center gap-1 text-xs">
          <Lock className="text-gold size-3 shrink-0" aria-hidden="true" />
          Seen only by <span className="font-mono">{seen.join(", ")}</span>
        </p>
      )}
      <LongText text={item.text} className="mt-1.5" />
      {same === null ? null : <SameTurnThought seat={same.seat} turn={same.turn} seq={entry.seq} />}
    </Shell>
  );
}

// Diplomacy ---------------------------------------------------------------------------------------

/**
 * An alliance: “name” and id, the name from the item, the frame, or the feed's history (a dissolved
 * alliance is gone from the frame); with `members`, its members too (two alliances may share a name).
 */
function AllianceName({
  id,
  name,
  members = false,
}: {
  readonly id: string | null;
  readonly name: string | null;
  readonly members?: boolean;
}) {
  const known = useMatch((s) =>
    id === null
      ? null
      : (Object.values(s.frame?.alliances ?? {}).find((a) => a?.id === id)?.name ?? null),
  );
  const feed = useFeed();
  const info = id === null ? null : (allianceNamesOf(feed).get(id) ?? null);
  const shown = name ?? known ?? info?.name ?? null;
  return (
    <span className="whitespace-nowrap">
      {shown === null ? null : (
        <>
          “<PlainText text={shown} className="font-medium" />”{" "}
        </>
      )}
      {id === null ? null : (
        <span className="text-muted-foreground font-mono text-[0.92em]">{id}</span>
      )}
      {members && info !== null && info.members.length > 0 ? (
        <span className="text-muted-foreground font-mono text-[0.92em]">
          {" "}
          ({info.members.join(", ")})
        </span>
      ) : null}
    </span>
  );
}

const until = (t: number | null): ReactNode =>
  t === null ? null : (
    <>
      {" "}
      until <GameTime t={t} />
    </>
  );

function proposalWords(kind: "alliance" | "pact"): string {
  return kind === "alliance" ? "an alliance" : "a pact";
}

function ProposalBody({ item }: { readonly item: FeedItemOf<"proposal"> }) {
  return (
    <>
      <p className="leading-snug">
        <Who id={item.from} /> proposes {proposalWords(item.kind)}
        {item.name === null ? null : (
          <>
            {" "}
            “<PlainText text={item.name} className="font-medium" />”
          </>
        )}{" "}
        to <Who id={item.to} />
        {until(item.until)}
      </p>
      <p className="text-muted-foreground mt-0.5 flex items-center gap-1 text-xs">
        <Lock className="text-gold size-3 shrink-0" aria-hidden="true" />
        Seen only by <span className="font-mono">{`${item.from}, ${item.to}`}</span> · expires{" "}
        <GameTime t={item.expiresAt} />
      </p>
      {item.text === "" ? null : <LongText text={item.text} className="mt-1.5" />}
    </>
  );
}

function DiplomacyBody({ item }: { readonly item: FeedItemOf<"diplomacy"> }) {
  const [a, b] = item.players;
  const pa = a === undefined ? "?" : <Who id={a} />;
  const pb = b === undefined ? "?" : <Who id={b} />;
  const cause =
    item.cause === null || item.cause === "left" ? null : (
      <span className={item.cause === "betrayal" ? "text-betrayal font-medium" : undefined}>
        {" "}
        ({item.cause === "betrayal" ? "by betrayal" : item.cause})
      </span>
    );
  switch (item.event) {
    case "alliance_formed":
      return (
        <p className="leading-snug">
          Alliance <AllianceName id={item.alliance} name={item.name} /> formed:{" "}
          <WhoList ids={item.players} />
        </p>
      );
    case "alliance_joined":
      return (
        <p className="leading-snug">
          {pa} joined alliance <AllianceName id={item.alliance} name={item.name} />
        </p>
      );
    case "alliance_left":
      return (
        <p className="leading-snug">
          {pa} left alliance <AllianceName id={item.alliance} name={item.name} members />
          {cause}
        </p>
      );
    case "alliance_dissolved":
      return (
        <p className="leading-snug">
          Alliance <AllianceName id={item.alliance} name={item.name} members /> dissolved
          {cause}
        </p>
      );
    case "pact_signed":
      return (
        <p className="leading-snug">
          {pa} and {pb} signed a non-aggression pact{until(item.expiresAt)}
        </p>
      );
    case "pact_renewed":
      return (
        <p className="leading-snug">
          {pa} and {pb} renewed their pact{until(item.expiresAt)}
        </p>
      );
    case "pact_ended":
      return (
        <p className="leading-snug">
          The pact between {pa} and {pb} ended{cause}
        </p>
      );
    case "pact_expired":
      return (
        <p className="leading-snug">
          The pact between {pa} and {pb} expired
        </p>
      );
  }
  return null;
}

// Military ----------------------------------------------------------------------------------------

function useUnits(units: FeedItemOf<"launch">["units"]): string {
  const skin = useSkin();
  if (skin === null) return "";
  return unitsText(units, (id) => skin.unit(id), skin.unitOrder);
}

function Lands({ at }: { readonly at: number }) {
  return (
    <>
      lands <GameTime t={at} />
      <TimeLeft at={at} />
    </>
  );
}

function LaunchBody({ item }: { readonly item: FeedItemOf<"launch"> }) {
  const units = useUnits(item.units);
  const target =
    item.target === null ? null : item.target === item.owner ? (
      <span className="text-muted-foreground"> (its own)</span>
    ) : (
      <>
        {" "}
        <Who id={item.target} paren />
      </>
    );
  const to =
    item.to === null ? (
      <span className="font-mono">{item.toIsland}</span>
    ) : (
      <CityRef id={item.to} />
    );
  const relief = item.kind === "attack" && item.foe !== null && item.foe !== item.target;
  let what: ReactNode;
  if (relief && item.foe !== null) {
    what = (
      <>
        sent a relief to {to}
        {target}, besieged by <Who id={item.foe} />
      </>
    );
  } else if (item.kind === "attack") {
    what = (
      <>
        launched {item.settlers ? "a conquest of" : "an attack on"} {to}
        {item.target === null ? <span className="text-muted-foreground"> (neutral)</span> : target}
      </>
    );
  } else if (item.kind === "found") {
    what = (
      <>
        sent settlers to found a city on <span className="font-mono">{item.toIsland}</span>
      </>
    );
  } else if (item.kind === "support") {
    what = (
      <>
        sent troops to defend {to}
        {target}
      </>
    );
  } else if (item.kind === "shipment") {
    what = (
      <>
        shipped resources to {to}
        {target}
      </>
    );
  } else if (item.kind === "spy") {
    what = (
      <>
        sent a spy to {to}
        {target}
      </>
    );
  } else {
    what = <>sent units back to {to}</>;
  }
  return (
    <>
      <p className="leading-snug">
        <Who id={item.owner} /> {what}
      </p>
      <p className="text-muted-foreground mt-0.5 text-xs">
        from <CityRef id={item.from} />
        {units === "" ? null : <> · {units}</>} · <Lands at={item.arriveAt} />
      </p>
    </>
  );
}

function BattleBody({ item }: { readonly item: FeedItemOf<"battle"> }) {
  const skin = useSkin();
  const winner = item.winner === "attacker" ? item.attacker : item.defender;
  const after = item.fell
    ? "the city fell"
    : item.siege === "started"
      ? "a siege begins"
      : item.siege === "broken"
        ? "the siege is broken"
        : null;
  return (
    <>
      <p className="leading-snug">
        <Who id={item.attacker} /> attacked{" "}
        {item.defender === "neutral" ? "the neutral garrison of" : <Who id={item.defender} />}
        {item.defender === "neutral" ? null : " at"} <CityRef id={item.city} />
        {skin === null ? null : (
          <span className="text-muted-foreground"> ({skin.battleKind(item.kind)})</span>
        )}
      </p>
      <p className="mt-0.5 text-xs">
        {winner === "neutral" ? "The garrison" : <Who id={winner} />} won
        {after === null ? null : <strong className="font-medium">: {after}</strong>}
      </p>
      <BattleReport ids={item.reports} />
    </>
  );
}

function SiegeBody({ item }: { readonly item: FeedItemOf<"siege"> }) {
  const skin = useSkin();
  if (item.event === "started") {
    return (
      <p className="leading-snug">
        <Who id={item.by} /> besieges <CityRef id={item.city} />
        {item.owner === null ? null : (
          <>
            {" "}
            <Who id={item.owner} paren />
          </>
        )}
        {item.endsAt === null ? null : (
          <>
            : the city falls at <GameTime t={item.endsAt} /> unless relieved
          </>
        )}
      </p>
    );
  }
  return (
    <p className="leading-snug">
      The siege of <CityRef id={item.city} /> by <Who id={item.by} /> is broken
      {item.cause === null || skin === null ? null : (
        <span className="text-muted-foreground"> ({skin.siegeCause(item.cause)})</span>
      )}
    </p>
  );
}

function BlocName({ k, members }: { readonly k: string; readonly members: readonly string[] }) {
  const current = useMatch(
    (s) => Object.values(s.frame?.alliances ?? {}).find((a) => a?.id === k)?.name ?? null,
  );
  const feed = useFeed();
  const name = current ?? allianceNamesOf(feed).get(k)?.name ?? null;
  return (
    <>
      {name === null ? null : (
        <>
          “<PlainText text={name} className="font-medium" />”{" "}
        </>
      )}
      (<WhoList ids={members} />)
    </>
  );
}

function CountdownBody({ item }: { readonly item: FeedItemOf<"countdown"> }) {
  if (item.event === "cancelled") {
    return (
      <p className="leading-snug">
        The domination countdown of <BlocName k={item.key} members={item.members} /> is cancelled
        {item.reason === null ? null : (
          <span className="text-muted-foreground"> ({item.reason.replaceAll("_", " ")})</span>
        )}
      </p>
    );
  }
  return (
    <p className="leading-snug">
      <BlocName k={item.key} members={item.members} /> holds{" "}
      {item.cities === null ? "enough" : fmtInt(item.cities)}
      {item.need === null ? null : ` of ${fmtInt(item.need)}`} cities
      {item.taken === null ? null : `, ${fmtInt(item.taken)} taken`}:{" "}
      {item.endsAt === null ? (
        "it wins if it holds"
      ) : (
        <strong className="font-medium">
          it wins at <GameTime t={item.endsAt} /> if it holds
        </strong>
      )}
    </p>
  );
}

function TurnBody({ item }: { readonly item: FeedItemOf<"turn"> }) {
  const rejected = item.rejected.reduce((n, r) => n + r.count, 0);
  return (
    <>
      <p className="leading-snug">
        <Who id={item.seat} />
        <span className="text-muted-foreground"> · turn {item.turn}</span>
      </p>
      {item.thought === null || item.thought === "" ? (
        <p className="text-muted-foreground mt-1 text-xs">No thought for this turn.</p>
      ) : (
        <LongText text={item.thought} className="mt-1 italic" />
      )}
      <p className="text-muted-foreground mt-1 text-xs">
        {plural(item.rounds, "round")} · {plural(item.calls, "call")}
        {rejected === 0 ? null : ` · ${fmtInt(rejected)} refused`}
        {item.messages.length === 0 ? null : ` · ${plural(item.messages.length, "message")} sent`}
      </p>
      {item.llm ? (
        <ReasoningToggle seat={item.seat} turn={item.turn} className="mt-1" />
      ) : (
        <OpenTurnButton seat={item.seat} turn={item.turn} className="mt-1" />
      )}
    </>
  );
}

function EndBody({ item }: { readonly item: FeedItemOf<"end"> }) {
  const how =
    item.reason === "domination"
      ? "by domination"
      : item.reason === "time"
        ? "on points at the end"
        : item.reason.replaceAll("_", " ");
  return (
    <p className="text-base leading-snug font-medium">
      The match is over:{" "}
      {item.winners.length === 0 ? (
        "no winner"
      ) : (
        <>
          <WhoList ids={item.winners} /> {item.winners.length === 1 ? "wins" : "win"} {how}
        </>
      )}
    </p>
  );
}

function eventRows(data: Readonly<Record<string, unknown>>): string {
  return Object.entries(data)
    .slice(0, 6)
    .map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join(" · ");
}

// The card of an item ------------------------------------------------------------------------------

function cardOf(entry: FeedEntry, selected: boolean): ReactNode {
  const item: FeedItem = entry.item;
  const shell = (icon: LucideIcon, kind: string, body: ReactNode, tone: Tone = "plain") => (
    <Shell entry={entry} icon={icon} kind={kind} tone={tone} selected={selected}>
      {body}
    </Shell>
  );
  switch (item.k) {
    case "message":
      return <MessageCard entry={entry} selected={selected} />;
    case "proposal":
      return shell(Handshake, "Proposal", <ProposalBody item={item} />);
    case "answer":
      return shell(
        Handshake,
        item.accept ? "Proposal accepted" : "Proposal refused",
        <p className="leading-snug">
          <Who id={item.to} /> {item.accept ? "accepted" : "refused"} <Who id={item.from} />
          ’s {item.kind} proposal
        </p>,
        item.accept ? "plain" : "quiet",
      );
    case "expired":
      return shell(
        Hourglass,
        "Proposal expired",
        <p className="leading-snug">
          <Who id={item.from} />
          ’s {item.kind} proposal to <Who id={item.to} /> expired unanswered
        </p>,
        "quiet",
      );
    case "diplomacy":
      return shell(
        item.cause === "betrayal" ? HeartCrack : Handshake,
        item.event.startsWith("alliance") ? "Alliance" : "Pact",
        <DiplomacyBody item={item} />,
        item.cause === "betrayal"
          ? "betrayal"
          : item.event === "alliance_formed"
            ? "gold"
            : "plain",
      );
    case "betrayal":
      return <BetrayalCard entry={entry} selected={selected} />;
    case "launch":
      if (item.againstAlly !== null) return <BetrayalCard entry={entry} selected={selected} />;
      return shell(
        item.kind === "attack" ? Swords : Ship,
        item.kind === "attack"
          ? item.foe !== null && item.foe !== item.target
            ? "Relief launched"
            : item.settlers
              ? "Conquest launched"
              : "Attack launched"
          : "Movement",
        <LaunchBody item={item} />,
        item.importance >= 2 ? "key" : item.importance === 0 ? "quiet" : "plain",
      );
    case "battle":
      return shell(
        Swords,
        "Battle",
        <BattleBody item={item} />,
        item.importance >= 2 ? "key" : "plain",
      );
    case "siege":
      return shell(
        Castle,
        item.event === "started" ? "Siege" : "Siege broken",
        <SiegeBody item={item} />,
        "key",
      );
    case "conquest":
      return shell(
        item.prize ? Crown : Flag,
        item.prize ? "The prize city taken" : "City conquered",
        <p className="leading-snug font-medium">
          <Who id={item.to} /> took {item.prize ? "the prize city " : null}
          <CityRef id={item.city} />
          {item.from === null ? null : (
            <>
              {" "}
              from <Who id={item.from} />
            </>
          )}
        </p>,
        "gold",
      );
    case "founding":
      return shell(
        Tent,
        "City founded",
        <p className="leading-snug">
          <Who id={item.owner} /> founded <CityRef id={item.city} /> on{" "}
          <span className="font-mono">{item.island}</span>
        </p>,
        "quiet",
      );
    case "spy":
      return shell(
        Eye,
        item.event === "spy_detected"
          ? "Spy caught"
          : item.event === "spy_failed"
            ? "Spy failed"
            : "Spying",
        <p className="leading-snug">
          {item.by === null ? "Someone" : <Who id={item.by} />}{" "}
          {item.event === "spy_detected"
            ? "was caught spying on"
            : item.event === "spy_failed"
              ? "failed to spy on"
              : "spied on"}{" "}
          <CityRef id={item.city} />
        </p>,
        "quiet",
      );
    case "elimination":
      return shell(
        Skull,
        "Eliminated",
        <p className="leading-snug font-medium">
          <Who id={item.player} /> was eliminated
        </p>,
        "betrayal",
      );
    case "countdown":
      return shell(
        Hourglass,
        item.event === "started" ? "Domination countdown" : "Countdown cancelled",
        <CountdownBody item={item} />,
        item.event === "started" ? "gold" : "plain",
      );
    case "event":
      return shell(
        Bell,
        item.type.replaceAll("_", " "),
        <p className="text-muted-foreground text-xs break-words">{eventRows(item.data)}</p>,
        "quiet",
      );
    case "turn":
      return shell(
        Brain,
        item.llm ? "Thought" : "Bot turn",
        <TurnBody item={item} />,
        item.llm ? "plain" : "quiet",
      );
    case "handoff":
      return shell(
        Bot,
        "Handed to a bot",
        <p className="leading-snug">
          <Who id={item.seat} /> is now played by a bot{" "}
          <span className="text-muted-foreground font-mono text-xs">({item.label})</span>
        </p>,
        "key",
      );
    case "end":
      return shell(Trophy, "The end", <EndBody item={item} />, "gold");
  }
  return null;
}

/** One feed item as a card (memoised: an entry never changes). */
export const FeedCard = memo(function FeedCard({
  entry,
  selected,
}: {
  readonly entry: FeedEntry;
  readonly selected: boolean;
}) {
  return cardOf(entry, selected);
});
