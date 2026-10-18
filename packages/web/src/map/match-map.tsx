import { NEUTRAL_COLOR } from "../lib/colors.ts";
import { useFrame, useMeta } from "../store/hooks.ts";
import { colorOf } from "../store/selectors.ts";

// STUB (owned by view agent A, phase-3 design §4.3 "Map"): the islands and cities of the frame,
// drawn plainly so the layout shows real data. It fills its parent box (the layout gives the size:
// a square on phones and tablets, the free centre space on desktop). Agent A replaces this file; the
// export name and the no-props signature stay.

export function MatchMap() {
  const meta = useMeta();
  const frame = useFrame();
  if (meta === null || frame === null) {
    return <div data-stub="map" className="bg-sea-deep size-full rounded-xl" />;
  }
  const { width, height, islands } = meta.map;
  const at = new Map(islands.map((i) => [i.id, i]));
  return (
    <svg
      data-stub="map"
      aria-label={`Map: ${islands.length} islands, ${Object.keys(frame.cities).length} cities`}
      viewBox={`0 0 ${width} ${height}`}
      className="bg-sea-deep size-full rounded-xl"
    >
      {islands.map((i) => (
        <circle
          key={i.id}
          data-island={i.id}
          cx={i.x}
          cy={i.y}
          r={8 + 4 * i.slots}
          fill="var(--sea)"
          stroke="var(--border)"
        />
      ))}
      {Object.values(frame.cities).map((c) => {
        const island = at.get(c.island);
        if (island === undefined) return null;
        const r = 8 + 4 * island.slots;
        const dx =
          island.slots <= 1 ? 0 : (c.slot - (island.slots - 1) / 2) * (r / island.slots) * 1.4;
        return (
          <circle
            key={c.id}
            data-city={c.id}
            cx={island.x + dx}
            cy={island.y}
            r={5}
            fill={c.owner === null ? NEUTRAL_COLOR : colorOf(meta, c.owner)}
          />
        );
      })}
    </svg>
  );
}
