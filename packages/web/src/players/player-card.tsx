import { Brain, Handshake } from "lucide-react";
import type { ReactNode } from "react";
import { GameTime } from "../common/game-time.tsx";
import { ModelBadge } from "../common/model-badge.tsx";
import { PlainText } from "../common/plain-text.tsx";
import { PlayerGlyph } from "../common/player-glyph.tsx";
import { fmtUsd } from "../lib/format.ts";
import { isPlayerId, type PlayerId } from "../lib/ids.ts";
import { playedBy } from "../lib/models.ts";
import { useDossier, useMatch, useSeat } from "../store/hooks.ts";
import { HoverPanel } from "./hover-panel.tsx";

// The player card (phase-3 design §4.3 "Player card"), on hover or keyboard focus of a player's
// name: name and id, who plays it (the model, a bot, or "Fake"), its profile's tagline, what it has
// spent so far (when the server serves costs), its alliance, and its last public thought. The
// spend comes from the dossier, fetched only while the card is open.

function Spend({ player }: { readonly player: PlayerId }) {
  const d = useDossier(player);
  if (d?.status !== "ok" || d.value.spentNanoUsd === null) return null;
  return (
    <p className="text-muted-foreground text-xs">
      Spent {fmtUsd(d.value.spentNanoUsd)}
      {d.value.capNanoUsd === null ? null : <> of its {fmtUsd(d.value.capNanoUsd)} cap</>}
    </p>
  );
}

function Body({ player }: { readonly player: string }) {
  const seat = useSeat(player);
  const alliance = useMatch((s) => {
    const id = isPlayerId(player) ? (s.frame?.players[player]?.alliance ?? null) : null;
    return id === null
      ? null
      : (Object.values(s.frame?.alliances ?? {}).find((a) => a?.id === id) ?? null);
  });
  const thought = useMatch((s) =>
    isPlayerId(player) ? (s.frame?.seats[player]?.lastThought ?? null) : null,
  );
  if (seat === null) {
    return <p className="font-mono text-sm">{player}</p>;
  }
  return (
    <div className="flex flex-col gap-2 text-sm">
      <div className="flex items-center gap-2">
        <PlayerGlyph color={seat.color} size={16} />
        <p className="min-w-0 flex-1 font-semibold">
          <bdi>{seat.name}</bdi>
          <span className="text-muted-foreground font-mono font-normal"> · {seat.seat}</span>
        </p>
        <ModelBadge seat={seat} />
      </div>
      <p className="text-muted-foreground text-xs">{playedBy(seat)}</p>
      {seat.profile === null ? null : (
        <p className="italic">
          <PlainText text={seat.profile.name} />
        </p>
      )}
      {isPlayerId(player) && seat.kind === "llm" ? <Spend player={player} /> : null}
      {alliance === null ? null : (
        <p className="text-gold flex items-start gap-1 text-xs">
          <Handshake className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
          <span>
            Alliance “<PlainText text={alliance.name} />” with{" "}
            <span className="font-mono">
              {alliance.members.filter((m) => m !== player).join(", ") || "nobody else"}
            </span>
          </span>
        </p>
      )}
      {thought === null ? null : (
        <div className="border-primary/40 border-l-2 pl-2">
          <p className="text-muted-foreground mb-0.5 flex items-center gap-1 text-[0.7rem]">
            <Brain className="size-3" aria-hidden="true" /> Last thought, turn {thought.turn} ·{" "}
            <GameTime t={thought.t} />
          </p>
          <PlainText text={thought.text} className="line-clamp-4 block text-xs italic" />
        </div>
      )}
      <p className="text-muted-foreground text-[0.7rem]">Click the name for its dossier.</p>
    </div>
  );
}

export function PlayerCard({
  player,
  children,
}: {
  readonly player: string;
  readonly children: ReactNode;
}) {
  return (
    <HoverPanel testId="player-card" className="w-72" content={<Body player={player} />}>
      {children}
    </HoverPanel>
  );
}
