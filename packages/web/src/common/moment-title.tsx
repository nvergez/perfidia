import { allianceNamesOf } from "../feed/filter.ts";
import { titleParts } from "../lib/caption.ts";
import { useFeed, useSeats } from "../store/hooks.ts";
import { PlainText } from "./plain-text.tsx";
import { PlayerGlyph } from "./player-glyph.tsx";

// A moment's title with names: "Opportunist (bot) · p2 betrayed its ally Turtle (bot) · p3 at c18",
// "Alliance “League p2” a2 dissolved" (ids stay visible next to the names).

export function MomentTitle({ title }: { readonly title: string }) {
  const seats = useSeats();
  const feed = useFeed();
  const alliances = allianceNamesOf(feed);
  const parts = titleParts(
    title,
    (id) => seats.some((s) => s.seat === id),
    (id) => alliances.get(id)?.name ?? null,
  );
  return (
    <>
      {parts.map((p, i) => {
        const key = `${i}`;
        if (p.k === "text") return <PlainText key={key} text={p.text} />;
        if (p.k === "player") {
          const seat = seats.find((s) => s.seat === p.id);
          return (
            <span key={key} className="whitespace-nowrap">
              <PlayerGlyph color={seat?.color ?? null} size={10} className="mr-1" />
              {seat === undefined ? null : (
                <>
                  <bdi>{seat.name}</bdi>
                  <span className="text-muted-foreground"> · </span>
                </>
              )}
              <span className="text-muted-foreground font-mono text-[0.85em]">{p.id}</span>
            </span>
          );
        }
        return (
          <span key={key}>
            {p.name === null ? null : (
              <>
                “<PlainText text={p.name} className="italic" />”{" "}
              </>
            )}
            <span className="text-muted-foreground font-mono text-[0.85em]">{p.id}</span>
          </span>
        );
      })}
    </>
  );
}
