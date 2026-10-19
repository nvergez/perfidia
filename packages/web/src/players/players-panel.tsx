import type { SeatInfo } from "@perfidia/protocol/spectator";
import { Bot, ChevronRight, Handshake, Landmark, Skull } from "lucide-react";
import { ModelBadge } from "../common/model-badge.tsx";
import { PlainText } from "../common/plain-text.tsx";
import { PlayerGlyph } from "../common/player-glyph.tsx";
import { fmtInt } from "../lib/format.ts";
import { isPlayerId } from "../lib/ids.ts";
import { playedBy } from "../lib/models.ts";
import { useMatch, useSeats } from "../store/hooks.ts";
import { uiActions } from "../store/ui.ts";

// The players tab (phase-3 design §4.2.3): every seat with its name and id, who plays it, its
// profile's tagline, and where it stands now; a click opens its dossier.

const clearHighlight = (): void => uiActions.setHighlight([]);

function SeatRow({ seat }: { readonly seat: SeatInfo }) {
  const id = seat.seat;
  const p = useMatch((s) => (isPlayerId(id) ? (s.frame?.players[id] ?? null) : null));
  const handoff = useMatch((s) => (isPlayerId(id) ? (s.frame?.seats[id]?.handoff ?? null) : null));
  const alliance = useMatch((s) => {
    const a = p?.alliance ?? null;
    return a === null
      ? null
      : (Object.values(s.frame?.alliances ?? {}).find((x) => x?.id === a) ?? null);
  });
  const highlight = (): void => uiActions.setHighlight([id]);
  return (
    <li>
      <button
        type="button"
        onClick={() => uiActions.openPlayer(id)}
        onMouseEnter={highlight}
        onMouseLeave={clearHighlight}
        onFocus={highlight}
        onBlur={clearHighlight}
        className="hover:bg-accent/40 bg-card flex w-full items-start gap-2 rounded-lg border p-2.5 text-left"
      >
        <PlayerGlyph color={seat.color} size={14} className="mt-1" />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 items-center gap-1.5 text-sm">
            <bdi className="truncate font-medium">{seat.name}</bdi>
            <span className="text-muted-foreground shrink-0 font-mono text-[0.85em]">· {id}</span>
            <ModelBadge seat={seat} className="ml-auto shrink-0" />
          </span>
          {seat.profile === null ? (
            <span className="text-muted-foreground text-xs">{playedBy(seat)}</span>
          ) : (
            <PlainText
              text={seat.profile.name}
              className="text-muted-foreground block text-xs italic"
            />
          )}
          {p === null ? null : (
            <span className="text-muted-foreground flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-xs">
              <span>
                rank <strong className="text-foreground">{p.rank}</strong>
              </span>
              <span className="tabular-nums">{fmtInt(p.score)} points</span>
              <span className="inline-flex items-center gap-0.5">
                <Landmark className="size-3" aria-hidden="true" /> {p.cities}
              </span>
              {alliance === null ? null : (
                <span className="text-gold inline-flex min-w-0 items-center gap-0.5">
                  <Handshake className="size-3 shrink-0" aria-hidden="true" />
                  <PlainText text={alliance.name} className="truncate" />
                </span>
              )}
              {p.alive ? null : (
                <span className="text-betrayal inline-flex items-center gap-0.5">
                  <Skull className="size-3" aria-hidden="true" /> eliminated
                </span>
              )}
              {handoff === null ? null : (
                <span className="inline-flex items-center gap-0.5">
                  <Bot className="size-3" aria-hidden="true" /> handed to a bot
                </span>
              )}
            </span>
          )}
        </span>
        <ChevronRight className="text-muted-foreground mt-1 size-4 shrink-0" aria-hidden="true" />
      </button>
    </li>
  );
}

export function PlayersPanel() {
  const seats = useSeats();
  return (
    <ul aria-label="Players" data-testid="players" className="flex flex-col gap-1.5">
      {seats.map((s) => (
        <SeatRow key={s.seat} seat={s} />
      ))}
    </ul>
  );
}
