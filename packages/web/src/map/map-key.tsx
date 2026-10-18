import type { Frame } from "@perfidia/protocol/spectator";
import type { ReactNode } from "react";
import { PlainText } from "../common/plain-text.tsx";
import { PlayerGlyph } from "../common/player-glyph.tsx";
import { useSeats } from "../store/hooks.ts";
import { arrowHead, burstPath, starPath } from "./geometry.ts";
import { BETRAYAL, blocColor } from "./style.ts";

// The map's key: the alliances (each with its outline hue) and what the symbols mean.

function Swatch({ children }: { readonly children: ReactNode }) {
  return (
    <svg aria-hidden="true" viewBox="-10 -10 20 20" className="size-4 shrink-0">
      {children}
    </svg>
  );
}

const ROWS: readonly { readonly label: string; readonly icon: ReactNode }[] = [
  {
    label: "City (owner's colour and shape)",
    icon: <circle r={5} fill="var(--marble)" stroke="black" strokeWidth={0.8} />,
  },
  {
    label: "Capital",
    icon: <path d={starPath(0, 0, 9, 4.6)} fill="none" stroke="var(--gold)" strokeWidth={1.4} />,
  },
  {
    label: "Taken by conquest",
    icon: <circle r={3.5} fill="var(--gold)" stroke="black" strokeWidth={0.8} />,
  },
  {
    label: "Siege (arc: time left)",
    icon: (
      <circle
        r={7}
        fill="none"
        stroke="var(--foreground)"
        strokeWidth={1.4}
        strokeDasharray="3 2"
      />
    ),
  },
  {
    label: "Battle (winner's colour)",
    icon: (
      <path
        d={burstPath(0, 0, 9, 5, 10)}
        fill="var(--foreground)"
        fillOpacity={0.25}
        stroke="var(--foreground)"
      />
    ),
  },
  {
    label: "Attack (size: army)",
    icon: (
      <>
        <path d="M-9 0H4" stroke="var(--foreground)" strokeWidth={1.6} />
        <path d={arrowHead({ x: 9, y: 0 }, { x: 1, y: 0 }, 6)} fill="var(--foreground)" />
      </>
    ),
  },
  {
    label: "Attack on an ally",
    icon: <circle r={6} fill="none" stroke={BETRAYAL} strokeWidth={2.2} />,
  },
  {
    label: "Support",
    icon: <path d="M-9 0H9" stroke="var(--foreground)" strokeWidth={1.4} strokeDasharray="4 3" />,
  },
  {
    label: "Convoy, settlers, spy",
    icon: <path d="M-9 0H9" stroke="var(--foreground)" strokeWidth={1.2} strokeDasharray="1.5 3" />,
  },
];

export function MapKey({ frame }: { readonly frame: Frame }) {
  const seats = useSeats();
  const colorIndex = new Map(seats.map((s) => [s.seat, s.color]));
  const alliances = Object.values(frame.alliances).filter(
    (a): a is NonNullable<typeof a> => a !== undefined && a.members.length >= 2,
  );
  return (
    <div className="bg-popover/90 text-popover-foreground flex max-h-[min(22rem,70%)] w-60 flex-col gap-2 overflow-y-auto rounded-lg border p-2 text-xs shadow-md backdrop-blur-sm [scrollbar-width:thin]">
      <section aria-label="Alliances" className="flex flex-col gap-1">
        <h3 className="text-muted-foreground font-medium">Alliances (outline)</h3>
        {alliances.length === 0 ? (
          <p className="text-muted-foreground">None yet: every player stands alone.</p>
        ) : (
          alliances.map((a) => (
            <div key={a.id} className="flex min-w-0 items-center gap-1.5">
              <Swatch>
                <circle r={6.5} fill="none" stroke={blocColor(a.id)} strokeWidth={2.2} />
              </Swatch>
              <span className="min-w-0 truncate">
                <PlainText text={a.name} />
                <span className="text-muted-foreground font-mono"> · {a.id}</span>
              </span>
              <span className="ml-auto flex shrink-0 items-center gap-1 font-mono">
                {a.members.map((m) => (
                  <span key={m} className="inline-flex items-center gap-0.5">
                    <PlayerGlyph color={colorIndex.get(m) ?? null} size={10} />
                    {m}
                  </span>
                ))}
              </span>
            </div>
          ))
        )}
      </section>
      <section aria-label="Symbols" className="flex flex-col gap-1">
        <h3 className="text-muted-foreground font-medium">Symbols</h3>
        <ul className="grid gap-1">
          {ROWS.map((r) => (
            <li key={r.label} className="flex items-center gap-1.5">
              <Swatch>{r.icon}</Swatch>
              {r.label}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
