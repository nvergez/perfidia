import type * as React from "react";
import { PlayerLabel } from "../common/player-label.tsx";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "../ui/hover-card.tsx";

// STUB (owned by view agent B, phase-3 design §4.3 "Player card"): a hover card around `children`
// for `player`. Agent B replaces this file; the export name and the props `{player, children}`
// stay.

export function PlayerCard({
  player,
  children,
}: {
  readonly player: string;
  readonly children: React.ReactNode;
}) {
  return (
    <HoverCard openDelay={200}>
      <HoverCardTrigger asChild>{children}</HoverCardTrigger>
      <HoverCardContent data-stub="player-card">
        <PlayerLabel player={player} model />
      </HoverCardContent>
    </HoverCard>
  );
}
