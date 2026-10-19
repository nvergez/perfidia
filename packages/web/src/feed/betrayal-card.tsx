import type { MomentContext } from "@perfidia/protocol/spectator";
import { ArrowLeftRight, Brain, MessageSquareQuote, Skull, Swords } from "lucide-react";
import { GameTime } from "../common/game-time.tsx";
import { PlainText } from "../common/plain-text.tsx";
import type { FeedEntry } from "../playback/timeline.ts";
import { isPlayerId } from "../lib/ids.ts";
import { useFeed, useMatch, useSkin } from "../store/hooks.ts";
import { controls } from "../store/session.ts";
import { uiActions } from "../store/ui.ts";
import { CityRef, TimeLeft, Who, unitsText } from "./bits.tsx";
import { betrayalBattle, seqOfItem } from "./filter.ts";
import { Shell } from "./shell.tsx";

// The large red card of a betrayal, and of an attack launched against an ally or a pact partner
// (phase-3 design §4.3, the same layout with the landing time): who turned on whom, where, since
// when they were bound, and the moment's context from the log: "What they said before" (the
// betrayer's last private messages to the victim within 48 game hours) and "What they were
// thinking" (its last public thoughts naming the victim in that window).

function Context({
  context,
  victim,
  relation,
}: {
  readonly context: MomentContext;
  readonly victim: string;
  readonly relation: "ally" | "pact";
}) {
  return (
    <div className="mt-2 flex flex-col gap-2.5">
      {context.since === null ? null : (
        <p className="text-muted-foreground text-xs">
          {relation === "ally" ? "Allied" : "Bound by a pact"} since <GameTime t={context.since} />
        </p>
      )}
      <section aria-label="What they said before">
        <h4 className="text-betrayal mb-1 flex items-center gap-1 text-xs font-semibold tracking-wide uppercase">
          <MessageSquareQuote className="size-3.5" aria-hidden="true" /> What they said before
        </h4>
        {context.messages.length === 0 ? (
          <p className="text-muted-foreground text-xs">
            Nothing to <span className="font-mono">{victim}</span> in the 48 hours before.
          </p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {context.messages.map((m) => {
              const seq = seqOfItem(m.item);
              return (
                <li key={m.item} className="border-betrayal/40 border-l-2 pl-2">
                  <button
                    type="button"
                    title="Go to this message"
                    onClick={() => (seq === null ? controls.seek(m.t) : controls.seekSeq(seq, m.t))}
                    className="text-muted-foreground hover:text-foreground font-mono text-[0.7rem] tabular-nums hover:underline"
                  >
                    <GameTime t={m.t} />
                  </button>
                  <PlainText text={m.text} className="block" />
                </li>
              );
            })}
          </ul>
        )}
      </section>
      <section aria-label="What they were thinking">
        <h4 className="text-betrayal mb-1 flex items-center gap-1 text-xs font-semibold tracking-wide uppercase">
          <Brain className="size-3.5" aria-hidden="true" /> What they were thinking
        </h4>
        {context.thoughts.length === 0 ? (
          <p className="text-muted-foreground text-xs">
            No thought named <span className="font-mono">{victim}</span> in the 48 hours before.
          </p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {context.thoughts.map((th) => (
              <li key={th.turn} className="border-primary/40 border-l-2 pl-2">
                <span className="text-muted-foreground font-mono text-[0.7rem] tabular-nums">
                  turn {th.turn} · <GameTime t={th.t} />
                </span>
                <PlainText text={th.text} className="block italic" />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/** "Everything between p2 and p3": the feed's pair mode for the two players of the card. */
function PairButton({ a, b }: { readonly a: string; readonly b: string }) {
  const id = useMatch((s) => s.id);
  if (id === null || a === b || !isPlayerId(a) || !isPlayerId(b)) return null;
  return (
    <button
      type="button"
      onClick={() => uiActions.setPair(id, [a, b])}
      className="text-primary hover:text-primary/80 mt-2 inline-flex items-center gap-1 text-xs font-medium"
    >
      <ArrowLeftRight className="size-3" aria-hidden="true" /> Everything between{" "}
      <span className="font-mono">{a}</span> and <span className="font-mono">{b}</span>
    </button>
  );
}

const rel = (r: "ally" | "pact"): string => (r === "ally" ? "its ally" : "its pact partner");

/** How the betrayal's attack went: the city held, fell, or is besieged. */
function Outcome({ entry }: { readonly entry: FeedEntry }) {
  const feed = useFeed();
  const item = entry.item;
  if (item.k !== "betrayal") return null;
  const battle = betrayalBattle(feed, entry.seq, item);
  if (battle === null) return null;
  return (
    <p className="mt-1 text-sm" data-testid="betrayal-outcome">
      {battle.winner === "defender" ? (
        <>
          The attack failed: <Who id={item.against} /> held <CityRef id={item.city} />.
        </>
      ) : battle.fell ? (
        <>
          The attack succeeded: <CityRef id={item.city} /> fell to <Who id={item.by} />.
        </>
      ) : (
        <>
          <Who id={item.by} /> won the battle at <CityRef id={item.city} />
          {battle.siege === "started" ? ": a siege begins." : "."}
        </>
      )}
    </p>
  );
}

export function BetrayalCard({
  entry,
  selected,
}: {
  readonly entry: FeedEntry;
  readonly selected: boolean;
}) {
  const skin = useSkin();

  const item = entry.item;
  if (item.k === "betrayal") {
    return (
      <Shell
        entry={entry}
        icon={Skull}
        kind="Betrayal"
        tone="betrayal"
        selected={selected}
        className="border-2 p-3"
      >
        <p className="text-base leading-snug font-semibold">
          <Who id={item.by} /> {item.relation === "ally" ? "betrayed" : "broke its pact with"}{" "}
          {item.relation === "ally" ? `${rel("ally")} ` : null}
          <Who id={item.against} /> at <CityRef id={item.city} />
        </p>
        <Outcome entry={entry} />
        <Context context={item.context} victim={item.against} relation={item.relation} />
        <PairButton a={item.by} b={item.against} />
      </Shell>
    );
  }
  if (item.k !== "launch" || item.againstAlly === null) return null;
  const foe = item.foe ?? item.target;
  const relief = item.foe !== null && item.target !== null && item.foe !== item.target;
  const units = skin === null ? "" : unitsText(item.units, (id) => skin.unit(id), skin.unitOrder);
  return (
    <Shell
      entry={entry}
      icon={Swords}
      kind="Attack on an ally launched"
      tone="betrayal"
      selected={selected}
      className="border-2 p-3"
    >
      <p className="text-base leading-snug font-semibold">
        <Who id={item.owner} /> launched an attack on {rel(item.againstAlly)}{" "}
        {foe === null ? "?" : <Who id={foe} />}
        {item.to === null ? null : relief ? (
          <>
            , besieging <CityRef id={item.to} />
          </>
        ) : (
          <>
            {" "}
            at <CityRef id={item.to} />
          </>
        )}
      </p>
      <p className="mt-1 text-sm">
        It lands at{" "}
        <strong>
          <GameTime t={item.arriveAt} />
        </strong>
        <TimeLeft at={item.arriveAt} />
        {units === "" ? null : <span className="text-muted-foreground"> · {units}</span>}
      </p>
      {item.context === null || foe === null ? null : (
        <Context context={item.context} victim={foe} relation={item.againstAlly} />
      )}
      {foe === null ? null : <PairButton a={item.owner} b={foe} />}
    </Shell>
  );
}
