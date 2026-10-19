import type { Frame } from "@perfidia/protocol/spectator";
import { Fragment, useMemo } from "react";
import { GameTime } from "../common/game-time.tsx";
import { PlainText } from "../common/plain-text.tsx";
import { PlayerGlyph } from "../common/player-glyph.tsx";
import { TimeLeft, Who } from "../feed/bits.tsx";
import { cn } from "../lib/cn.ts";
import { useDomination, useFeed, useMatch, useMomentsSoFar, useStandings } from "../store/hooks.ts";
import { controls } from "../store/session.ts";
import { uiActions } from "../store/ui.ts";
import { buildStory, type StoryPart, type StorySentence } from "./story.ts";

// The story strip (phase-3 design §4.3): one line on top of the match view, filled by templates
// from the frame and the moments (`story.ts`): the time, who leads and by how much, the bloc
// closest to a domination win, and the last betrayal (or the attack on an ally now at sea).

const NO_ALLIANCES: Frame["alliances"] = Object.freeze({});
const NO_MOVEMENTS: Frame["movements"] = Object.freeze({});

/** A bloc member in the strip: glyph and id. */
function Member({ id }: { readonly id: string }) {
  const color = useMatch((s) => s.meta?.seats.find((x) => x.seat === id)?.color ?? null);
  return (
    <span className="whitespace-nowrap">
      <PlayerGlyph color={color} size={9} className="mr-0.5" />
      <span className="font-mono text-[0.92em]">{id}</span>
    </span>
  );
}

function Part({ part }: { readonly part: StoryPart }) {
  switch (part.k) {
    case "text":
      return <>{part.text}</>;
    case "strong":
      return <strong className="font-semibold">{part.text}</strong>;
    case "player":
      return <Who id={part.id} />;
    case "alliance":
      return <PlainText text={part.name} className="font-medium italic" />;
    case "time":
      return <GameTime t={part.t} className="font-mono text-[0.92em]" />;
    case "member":
      return <Member id={part.id} />;
    case "left":
      return <TimeLeft at={part.at} className="text-inherit" />;
  }
  return null;
}

/** A sentence's parts with keys (a sentence is rebuilt whole, its parts never reorder). */
function keyedParts(s: StorySentence): { readonly key: string; readonly part: StoryPart }[] {
  return s.parts.map((part, i) => ({ key: `${s.key}${i}`, part }));
}

function Sentence({ s }: { readonly s: StorySentence }) {
  const className = cn(
    s.tone === "betrayal" && "text-betrayal",
    s.tone === "danger" && "text-betrayal font-medium",
  );
  const body = (
    <>
      {s.tone === "danger" ? (
        <span
          aria-hidden="true"
          className="bg-betrayal mr-1.5 inline-block size-2 rounded-full align-middle motion-safe:animate-pulse"
        />
      ) : null}
      {keyedParts(s).map((p) => (
        <Part key={p.key} part={p.part} />
      ))}
    </>
  );
  const seek = s.seek;
  if (seek === undefined) {
    return (
      <span data-story={s.key} className={className}>
        {body}
      </span>
    );
  }
  // The irony sentence goes to what it tells of (the playhead to its line, the card selected).
  return (
    <button
      type="button"
      data-story={s.key}
      title="Go to this moment"
      onClick={() => {
        uiActions.selectItem(seek.item);
        controls.seekSeq(seek.seq, seek.t);
      }}
      className={cn(
        "inline cursor-pointer rounded-sm text-left underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:outline-none",
        className,
      )}
    >
      {body}
    </button>
  );
}

export function StoryStrip() {
  // The clock moves once a game minute: the strip re-renders no more often.
  const t = useMatch((s) => Math.floor(s.playhead / 60) * 60);
  const standings = useStandings();
  const result = useMatch((s) => s.frame?.result ?? null);
  const domination = useDomination();
  const alliances = useMatch((s) => s.frame?.alliances ?? NO_ALLIANCES);
  const movements = useMatch((s) => s.frame?.movements ?? NO_MOVEMENTS);
  const moments = useMomentsSoFar();
  const feed = useFeed();
  const sentences = useMemo(
    () => buildStory({ t, standings, result, domination, alliances, movements, moments, feed }),
    [t, standings, result, domination, alliances, movements, moments, feed],
  );
  return (
    <p data-testid="story" className="bg-card rounded-xl border px-3 py-2 text-sm leading-relaxed">
      {sentences.map((s, i) => (
        <Fragment key={s.key}>
          {i === 0 ? null : <span className="text-muted-foreground"> · </span>}
          <Sentence s={s} />
        </Fragment>
      ))}
    </p>
  );
}
