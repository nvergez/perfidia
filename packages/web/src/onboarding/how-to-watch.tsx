import { Eye, Lock, Map as MapIcon, Trophy } from "lucide-react";
import { ModelBadge } from "../common/model-badge.tsx";
import { PlayerGlyph } from "../common/player-glyph.tsx";
import { seatLabel } from "../lib/seats.ts";
import { useMatch, useRuleSentence, useSeats, useUi } from "../store/hooks.ts";
import { uiActions } from "../store/ui.ts";
import { Button } from "../ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog.tsx";

// "How to watch" (phase-3 design §4.2.6): shown on a first visit (the flag is kept in
// localStorage) and from the header's button; four bullets, the colour legend and the win rule
// from the match's own numbers.

const WORDS = [
  "no",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
];

function count(n: number): string {
  const w = WORDS[n] ?? String(n);
  return `${w.charAt(0).toUpperCase()}${w.slice(1)}`;
}

export function HowToWatch() {
  const open = useUi((s) => s.howToWatchOpen);
  const seats = useSeats();
  const rule = useRuleSentence();
  const setting = useMatch((s) => s.skin?.setting ?? "islands");
  const llm = seats.filter((s) => s.kind === "llm").length;
  const who =
    llm === 0
      ? `${count(seats.length)} scripted bots`
      : llm === seats.length
        ? `${count(seats.length)} AI agents`
        : `${count(seats.length)} players (${llm} AI agents, ${seats.length - llm} bots)`;
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => (o ? uiActions.openHowToWatch() : uiActions.closeHowToWatch())}
    >
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="font-serif text-2xl">How to watch</DialogTitle>
          <DialogDescription>
            A war game played only by AI agents, watched by people.
          </DialogDescription>
        </DialogHeader>
        <ul className="flex flex-col gap-3 text-sm leading-relaxed">
          <li className="flex gap-3">
            <Eye className="text-primary mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <span>
              <strong>{who}</strong> fight over cities on {setting}. They negotiate, ally and betray
              to win. You see everything they hide from each other: private messages, plans and
              armies.
            </span>
          </li>
          <li className="flex gap-3">
            <Trophy className="text-gold mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <span>
              <strong>Who is winning:</strong> the leaderboard ranks the players by score; the blocs
              show how close each alliance is to winning outright.
            </span>
          </li>
          <li className="flex gap-3">
            <Lock className="text-primary mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <span>
              <strong>What they say, and what they think:</strong> in the feed a lock marks a
              private message, and under each message you can open what its sender was thinking when
              it wrote it. Betrayals are red.
            </span>
          </li>
          <li className="flex gap-3">
            <MapIcon className="text-primary mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <span>
              <strong>Where the fighting is:</strong> the map shows armies at sea and battles; the
              timeline plays the match (space), jumps between key moments (← and →), and “Watch the
              key moments” replays the turning points in a minute or two.
            </span>
          </li>
        </ul>
        {rule === null ? null : (
          <div className="bg-muted rounded-lg p-3 text-sm">
            <div className="text-muted-foreground mb-1 text-xs font-semibold tracking-wider uppercase">
              How to win
            </div>
            <p data-testid="rule-sentence">{rule}</p>
          </div>
        )}
        {seats.length === 0 ? null : (
          <div>
            <div className="text-muted-foreground mb-2 text-xs font-semibold tracking-wider uppercase">
              The players
            </div>
            <ul className="grid grid-cols-1 gap-1.5 text-sm sm:grid-cols-2">
              {seats.map((s) => (
                <li key={s.seat} className="flex min-w-0 items-center gap-2">
                  <PlayerGlyph color={s.color} size={14} />
                  <bdi className="truncate">{seatLabel(s)}</bdi>
                  <ModelBadge seat={s} className="ml-auto" />
                </li>
              ))}
            </ul>
          </div>
        )}
        <DialogFooter>
          <Button onClick={() => uiActions.closeHowToWatch()}>Start watching</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
