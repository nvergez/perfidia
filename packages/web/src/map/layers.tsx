// oxlint-disable jsx-a11y/prefer-tag-over-role -- cities and battles are SVG groups acting as buttons (an SVG group cannot be a <button>)
import type { SpectatorIsland } from "@perfidia/protocol/spectator";
import { memo, type KeyboardEvent } from "react";
import type { Skin } from "../skins/index.ts";
import {
  arcPath,
  arrowHead,
  burstPath,
  CITY_R,
  curvePath,
  islandRadius,
  starPath,
  tangentAt,
  templePath,
  type Route,
} from "./geometry.ts";
import { BETRAYAL, PRIZE_EDGE, PRIZE_LAND } from "./style.ts";

// The map's SVG pieces (phase-3 design §4.3 "Map"). Each piece is memoised on plain props, so a
// frame that changes one city re-renders that city only; moving markers are positioned by the
// map's animation loop through refs, never by React. The marker and city layers ignore the pointer
// but for these pieces (`pointer-events-auto`), so it reaches what lies under their empty parts.

/** Islands: circles tinted by kind; the prize island in gold with a temple. Static per match. */
export const IslandsLayer = memo(function IslandsLayer({
  islands,
  tints,
  skin,
}: {
  readonly islands: readonly SpectatorIsland[];
  readonly tints: ReadonlyMap<string, string>;
  readonly skin: Skin;
}) {
  return (
    <g aria-hidden="true">
      {islands.map((i) => {
        const r = islandRadius(i.slots);
        const prize = skin.isPrizeIsland(i.kind);
        return (
          <g key={i.id} data-island={i.id}>
            <title>{`${i.id} · ${skin.islandKind(i.kind).name}`}</title>
            <circle
              cx={i.x}
              cy={i.y}
              r={r + 3}
              fill="none"
              stroke={prize ? PRIZE_EDGE : "oklch(0.45 0.05 230)"}
              strokeOpacity={prize ? 0.55 : 0.28}
              strokeWidth={prize ? 1.2 : 0.8}
            />
            <circle
              cx={i.x}
              cy={i.y}
              r={r}
              fill={prize ? PRIZE_LAND : (tints.get(i.kind) ?? "#334155")}
              stroke={prize ? PRIZE_EDGE : "oklch(0.55 0.04 230)"}
              strokeOpacity={prize ? 0.9 : 0.45}
              strokeWidth={0.8}
            />
            {prize ? <path d={templePath(i.x, i.y - r - 6, 5)} fill={PRIZE_EDGE} /> : null}
          </g>
        );
      })}
    </g>
  );
});

export interface CityMarkProps {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly fill: string;
  /** The owner's shape, a path in [-1, 1]². */
  readonly shape: string;
  /** The alliance outline hue (null: not in an alliance). */
  readonly ring: string | null;
  readonly capital: boolean;
  readonly taken: boolean;
  /** The besieger's colour and the countdown arc still to run. */
  readonly siegeColor: string | null;
  readonly siegeArc: string;
  readonly dim: boolean;
  readonly selected: boolean;
  /** Pointed at by the key moments reel. */
  readonly focus: boolean;
  /** Where the city's id is written (outward from its island), or nowhere (a small map). */
  readonly label: "below" | "left" | "right" | null;
  readonly title: string;
  /** The map's one tab stop among the cities (a roving tab index: arrows move between them). */
  readonly tabStop: boolean;
  /** City id labels' font size, in map units. */
  readonly labelSize: number;
  readonly onSelect: (id: string) => void;
  /** An arrow, Home or End key on this city: the map moves the focus. */
  readonly onMove: (id: string, key: string) => void;
}

const MOVE_KEYS = new Set(["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp", "Home", "End"]);

export const CityMark = memo(function CityMark(p: CityMarkProps) {
  // Clear of the capital's star.
  const labelGap = p.capital ? CITY_R * 2 + 1.5 : CITY_R + 3;
  const onKey = (e: KeyboardEvent<SVGGElement>): void => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      p.onSelect(p.id);
    } else if (MOVE_KEYS.has(e.key) && !e.altKey && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      p.onMove(p.id, e.key);
    }
  };
  return (
    <g
      data-city={p.id}
      role="button"
      tabIndex={p.tabStop ? 0 : -1}
      aria-label={p.title}
      className="pointer-events-auto cursor-pointer outline-none [&:focus-visible>.focus-ring]:opacity-100"
      opacity={p.dim ? 0.22 : 1}
      onClick={() => p.onSelect(p.id)}
      onKeyDown={onKey}
    >
      <title>{p.title}</title>
      <circle
        className="focus-ring pointer-events-none opacity-0"
        cx={p.x}
        cy={p.y}
        r={CITY_R + 5.5}
        fill="none"
        stroke="var(--ring)"
        strokeWidth={1.4}
      />
      {p.selected || p.focus ? (
        <circle
          cx={p.x}
          cy={p.y}
          r={CITY_R + 5}
          fill="var(--gold)"
          fillOpacity={0.18}
          stroke="var(--gold)"
          strokeWidth={1.4}
          className={p.focus ? "motion-safe:animate-pulse" : undefined}
        />
      ) : null}
      {p.siegeColor === null ? null : (
        <>
          <circle
            cx={p.x}
            cy={p.y}
            r={CITY_R + 3.6}
            fill="none"
            stroke={p.siegeColor}
            strokeWidth={1.1}
            strokeDasharray="2 1.6"
          />
          <path d={p.siegeArc} fill="none" stroke={p.siegeColor} strokeWidth={1.8} />
        </>
      )}
      {p.capital ? (
        <path
          d={starPath(p.x, p.y, CITY_R * 2, CITY_R * 1.05)}
          fill="none"
          stroke="var(--gold)"
          strokeWidth={0.9}
          strokeLinejoin="round"
        />
      ) : null}
      {p.ring === null ? null : (
        <circle cx={p.x} cy={p.y} r={CITY_R + 2.1} fill="none" stroke={p.ring} strokeWidth={1.6} />
      )}
      <path
        data-shape=""
        d={p.shape}
        transform={`translate(${p.x} ${p.y}) scale(${CITY_R})`}
        fill={p.fill}
        stroke="rgb(0 0 0 / 0.6)"
        strokeWidth={0.16}
      />
      {p.taken ? (
        <circle
          cx={p.x + CITY_R * 0.9}
          cy={p.y - CITY_R * 0.9}
          r={1.8}
          fill="var(--gold)"
          stroke="rgb(0 0 0 / 0.6)"
          strokeWidth={0.5}
        />
      ) : null}
      {p.label === null ? null : (
        <text
          x={p.label === "left" ? p.x - labelGap : p.label === "right" ? p.x + labelGap : p.x}
          y={p.label === "below" ? p.y + labelGap + p.labelSize * 1.35 : p.y + p.labelSize * 0.35}
          textAnchor={p.label === "left" ? "end" : p.label === "right" ? "start" : "middle"}
          fontSize={p.labelSize}
          fill="var(--foreground)"
          fillOpacity={0.8}
          className="pointer-events-none font-mono select-none"
        >
          {p.id}
        </text>
      )}
    </g>
  );
});

/** A siege's countdown arc: the share of the siege still to run. */
export function siegeArcOf(
  x: number,
  y: number,
  t: number,
  startT: number,
  endsAt: number | null,
): string {
  if (endsAt === null || endsAt <= startT) return "";
  const left = Math.round(((endsAt - t) / (endsAt - startT)) * 100) / 100;
  return arcPath(x, y, CITY_R + 6, left);
}

/** A battle's flash at its city, in the winner's colour, fading over two game hours. */
export const BattleFlash = memo(function BattleFlash({
  x,
  y,
  color,
  fade,
  pulse,
  title,
  onOpen,
}: {
  readonly x: number;
  readonly y: number;
  readonly color: string;
  /** 1 just after the battle, down to 0 two hours later. */
  readonly fade: number;
  readonly pulse: boolean;
  readonly title: string;
  readonly onOpen: () => void;
}) {
  return (
    <g
      role="button"
      tabIndex={0}
      aria-label={title}
      className="pointer-events-auto cursor-pointer outline-none"
      opacity={0.35 + 0.65 * fade}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
    >
      <title>{title}</title>
      <path
        d={burstPath(x, y, CITY_R * 2.6, CITY_R * 1.5, 10)}
        fill={color}
        fillOpacity={0.25}
        stroke={color}
        strokeWidth={1.1}
        strokeLinejoin="round"
        className={pulse ? "motion-safe:animate-pulse" : undefined}
      />
    </g>
  );
});

export interface RouteView {
  readonly id: string;
  readonly kind: string;
  readonly route: Route;
  readonly color: string;
  readonly againstAlly: boolean;
  readonly dim: boolean;
}

/** A movement's line: attacks solid with an arrowhead and a reticle, supports dashed, the rest thin. */
/** Views are rebuilt on every render; their parts are stable (routes are cached per movement). */
const sameRoute = (a: RouteView, b: RouteView): boolean =>
  a.id === b.id &&
  a.kind === b.kind &&
  a.route === b.route &&
  a.color === b.color &&
  a.againstAlly === b.againstAlly &&
  a.dim === b.dim;

const sameMarker = (a: MarkerView, b: MarkerView): boolean =>
  a.id === b.id &&
  a.kind === b.kind &&
  a.color === b.color &&
  a.shape === b.shape &&
  a.r === b.r &&
  a.againstAlly === b.againstAlly &&
  a.dim === b.dim &&
  a.title === b.title;

export const RouteLine = memo(
  function RouteLine({ v }: { readonly v: RouteView }) {
    const d = curvePath(v.route.drawn);
    const end = v.route.drawn.p1;
    const target = v.route.curve.p1;
    const attack = v.kind === "attack";
    const ret = v.kind === "return";
    const small = !attack && !ret && v.kind !== "support";
    const color = v.againstAlly ? BETRAYAL : v.color;
    return (
      <g opacity={v.dim ? 0.15 : ret ? 0.4 : small ? 0.7 : 0.9} aria-hidden="true">
        <path
          d={d}
          fill="none"
          stroke={color}
          strokeWidth={attack ? 1.5 : small ? 0.8 : 1.2}
          strokeDasharray={
            v.kind === "support" ? "4 3" : small ? "1.2 2.4" : ret ? "6 2" : undefined
          }
          strokeLinecap="round"
        />
        {attack ? (
          <>
            <path d={arrowHead(end, tangentAt(v.route.drawn, 1), 5)} fill={color} />
            <circle
              cx={target.x}
              cy={target.y}
              r={CITY_R + 3.2}
              fill="none"
              stroke={color}
              strokeWidth={0.8}
              strokeDasharray="1.5 1.5"
            />
          </>
        ) : null}
      </g>
    );
  },
  (a, b) => sameRoute(a.v, b.v),
);

export interface MarkerView {
  readonly id: string;
  readonly kind: string;
  readonly color: string;
  readonly shape: string;
  readonly r: number;
  readonly againstAlly: boolean;
  readonly dim: boolean;
  readonly title: string;
}

/** A movement's marker; its `transform` (the position) is written by the map's loop. */
export const Marker = memo(
  function Marker({
    v,
    setRef,
  }: {
    readonly v: MarkerView;
    readonly setRef: (id: string, el: SVGGElement | null) => void;
  }) {
    return (
      <g
        ref={(el) => setRef(v.id, el)}
        data-movement={v.id}
        className="pointer-events-auto"
        opacity={v.dim ? 0.2 : v.kind === "return" ? 0.55 : 1}
      >
        <title>{v.title}</title>
        {v.againstAlly ? (
          <circle
            r={v.r + 2.6}
            fill="none"
            stroke={BETRAYAL}
            strokeWidth={1.8}
            className="motion-safe:animate-pulse"
          />
        ) : null}
        <path
          d={v.shape}
          transform={`scale(${v.r})`}
          fill={v.color}
          stroke={v.againstAlly ? BETRAYAL : "rgb(0 0 0 / 0.7)"}
          strokeWidth={v.againstAlly ? 2 : 1}
          vectorEffect="non-scaling-stroke"
        />
      </g>
    );
  },
  (a, b) => a.setRef === b.setRef && sameMarker(a.v, b.v),
);
