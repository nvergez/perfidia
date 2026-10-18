import type { CityEnt, Frame, MatchMeta, MovementEnt } from "@perfidia/protocol/spectator";
import { Info, Maximize2, Minus, Plus } from "lucide-react";
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { NEUTRAL_COLOR, playerShape } from "../lib/colors.ts";
import { cn } from "../lib/cn.ts";
import { fmtInt } from "../lib/format.ts";
import { isCityId } from "../lib/ids.ts";
import { fmtClock, HOUR } from "../lib/time.ts";
import type { Skin } from "../skins/index.ts";
import {
  useFeed,
  useFrame,
  useLayout,
  useMatch,
  useMeta,
  usePlayhead,
  usePrefersReducedMotion,
  useSkin,
  useTick,
  useUi,
} from "../store/hooks.ts";
import { colorOf, labelOf, shapeOf } from "../store/selectors.ts";
import { playheadNow } from "../store/session.ts";
import { uiActions } from "../store/ui.ts";
import { useReelFocus } from "../timeline/reel-focus.ts";
import { Button } from "../ui/button.tsx";
import { CityPopover } from "./city-popover.tsx";
import { BATTLE_FLASH_S, citiesOfItem, createFeedFacts, recentBattles } from "./derive.ts";
import {
  cityPoint,
  indexIslands,
  markerAt,
  markerRadius,
  movementEnd,
  movementStart,
  routeBetween,
  slotOffset,
  unitCount,
  type IslandIndex,
  type Route,
} from "./geometry.ts";
import {
  BattleFlash,
  CityMark,
  IslandsLayer,
  Marker,
  RouteLine,
  siegeArcOf,
  type MarkerView,
  type RouteView,
} from "./layers.tsx";
import { MapKey } from "./map-key.tsx";
import { ReportDialog } from "./report-dialog.tsx";
import { landTints, blocColor } from "./style.ts";
import { useElementSize } from "./use-size.ts";
import { useZoomPan } from "./use-zoom-pan.ts";

// The map (phase-3 design §4.3 "Map (SVG)"): islands, cities in their owners' colours and shapes,
// capitals, taken cities, sieges with their countdown, alliances as outline rings, movements as
// curved routes with moving markers, battles flashing for two game hours. It fills its parent box
// (an SVG with a view box, "meet" scaling); zoom and pan with the wheel, a pinch or a drag, and the
// buttons. Markers move on every animation frame through refs (no React render per frame); with
// reduced motion they are placed at each store update instead, and nothing pulses.

const CIRCLE = playerShape(0).d;
const SIEGE_DEFAULT_S = 6 * 3_600;

/** Routes by movement entity: a movement's route never changes while the entity does not. */
const routes = new WeakMap<MovementEnt, Route | null>();

function routeOf(islands: IslandIndex, cities: Frame["cities"], m: MovementEnt): Route | null {
  const hit = routes.get(m);
  if (hit !== undefined) return hit;
  const a = movementStart(islands, cities, m);
  const b = movementEnd(islands, cities, m);
  const r = a === null || b === null ? null : routeBetween(a, b);
  routes.set(m, r);
  return r;
}

const KIND_WORDS: Readonly<Record<string, string>> = Object.freeze({
  attack: "attack on",
  support: "support for",
  shipment: "shipment to",
  found: "settlers bound for",
  spy: "spy on",
  return: "returning to",
});

function unitsText(skin: Skin, units: Readonly<Record<string, number>>): string {
  const parts = Object.entries(units)
    .toSorted(([a], [b]) => skin.unitOrder.indexOf(a) - skin.unitOrder.indexOf(b))
    .map(
      ([u, n]) =>
        `${fmtInt(n)} ${(n === 1 ? skin.unit(u).name : skin.unit(u).plural).toLowerCase()}`,
    );
  return parts.length === 0 ? "no units" : parts.join(", ");
}

/** A city's id goes outward: left or right of a city on the side of its island, else below. */
function labelSide(islands: IslandIndex, c: CityEnt): "below" | "left" | "right" {
  const i = islands.get(c.island);
  const dx = i === undefined ? 0 : slotOffset(i.slots, c.slot).x;
  return dx < -0.5 ? "left" : dx > 0.5 ? "right" : "below";
}

export function MatchMap() {
  const meta = useMeta();
  const frame = useFrame();
  const skin = useSkin();
  if (meta === null || frame === null || skin === null) {
    return <div className="bg-sea-deep size-full rounded-xl" aria-hidden="true" />;
  }
  return <MapView meta={meta} frame={frame} skin={skin} />;
}

interface MarkerSpec {
  readonly route: Route;
  readonly departAt: number;
  readonly arriveAt: number;
}

function MapView({
  meta,
  frame,
  skin,
}: {
  readonly meta: MatchMeta;
  readonly frame: Frame;
  readonly skin: Skin;
}) {
  const { width: W, height: H } = meta.map;
  const islands = useMemo(() => indexIslands(meta.map.islands), [meta]);
  const tints = useMemo(() => landTints(meta.map.islands), [meta]);
  const layout = useLayout();
  const reduced = usePrefersReducedMotion();
  const svgRef = useRef<SVGSVGElement>(null);
  const groupRef = useRef<SVGGElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const zp = useZoomPan(svgRef, groupRef, W, H, layout === "desktop");
  const size = useElementSize(boxRef);
  const highlight = useUi((s) => s.highlight);
  const selectedCity = useUi((s) => s.selectedCity);
  const focus = useReelFocus();
  const playhead = usePlayhead();
  const feed = useFeed();
  const [facts] = useState(createFeedFacts);
  const { againstAlly, siegeStarts } = facts(feed);
  const [keyOpen, setKeyOpen] = useState(false);

  const lit = useMemo(() => {
    const ids = highlight.length > 0 ? highlight : focus.players;
    return ids.length === 0 ? null : new Set<string>(ids);
  }, [highlight, focus.players]);
  // The reel's moment, else the feed card last clicked, rings its cities.
  const selectedItem = useUi((s) => s.selectedItem);
  const ringed = (
    focus.cities.length > 0 ? focus.cities : citiesOfItem(feed, selectedItem, playhead)
  ).join(",");
  const focusCities = useMemo(() => new Set(ringed === "" ? [] : ringed.split(",")), [ringed]);
  const dimOf = (owner: string | null): boolean =>
    lit !== null && (owner === null || !lit.has(owner));

  // Players' alliance rings: an alliance of two or more draws a shared outline around its cities.
  const ringOf = useMemo(() => {
    const out = new Map<string, string>();
    for (const a of Object.values(frame.alliances)) {
      if (a === undefined || a.members.length < 2) continue;
      for (const m of a.members) out.set(m, blocColor(a.id));
    }
    return out;
  }, [frame.alliances]);

  const pxPerTile = Math.min(size.width / W, size.height / H);
  const showLabels = zp.zoomed || pxPerTile >= 0.9;

  const wasDrag = zp.wasDrag;
  const onSelect = useCallback(
    (id: string) => {
      if (wasDrag() || !isCityId(id)) return;
      uiActions.selectCity(id);
    },
    [wasDrag],
  );

  // Cities -----------------------------------------------------------------------------------------
  const siegeT = Math.floor(playhead / 60) * 60;
  const cityMarks = Object.values(frame.cities).map((c: CityEnt | undefined) => {
    if (c === undefined) return null;
    const p = cityPoint(islands, c);
    if (p === null) return null;
    const ext = skin.city(c);
    const owner = c.owner;
    const siege = ext.siege;
    const start = siegeStarts.get(c.id);
    const siegeStart =
      siege === null
        ? 0
        : start !== undefined && start.endsAt === siege.endsAt
          ? start.t
          : (siege.endsAt ?? 0) - SIEGE_DEFAULT_S;
    const parts = [
      `${c.id}${c.name === c.id ? "" : ` ${c.name}`}`,
      owner === null ? "neutral" : labelOf(meta, owner),
    ];
    if (c.capitalOf !== null) parts.push("capital");
    if (ext.prize && skin.prizeName !== null) parts.push(skin.prizeName);
    if (ext.taken) parts.push("taken by conquest");
    if (siege !== null) {
      parts.push(
        `besieged by ${labelOf(meta, siege.by)}${siege.endsAt === null ? "" : ` until ${fmtClock(siege.endsAt)}`}`,
      );
    }
    return (
      <CityMark
        key={c.id}
        id={c.id}
        x={p.x}
        y={p.y}
        fill={owner === null ? NEUTRAL_COLOR : colorOf(meta, owner)}
        shape={owner === null ? CIRCLE : shapeOf(meta, owner).d}
        ring={owner === null ? null : (ringOf.get(owner) ?? null)}
        capital={c.capitalOf !== null}
        taken={ext.taken}
        siegeColor={siege === null ? null : colorOf(meta, siege.by)}
        siegeArc={siege === null ? "" : siegeArcOf(p.x, p.y, siegeT, siegeStart, siege.endsAt)}
        dim={dimOf(owner)}
        selected={selectedCity === c.id}
        focus={focusCities.has(c.id)}
        label={showLabels ? labelSide(islands, c) : null}
        title={parts.join(", ")}
        onSelect={onSelect}
      />
    );
  });

  // Battles ----------------------------------------------------------------------------------------
  const flashes = recentBattles(feed, playhead).map((b) => {
    const c = frame.cities[b.city];
    const p = c === undefined ? null : cityPoint(islands, c);
    if (p === null) return null;
    const fade = 1 - Math.min(1, Math.max(0, (playhead - b.t) / BATTLE_FLASH_S));
    const winner = b.winner === null ? "the neutral garrison" : labelOf(meta, b.winner);
    const report = b.reports[0] ?? null;
    return (
      <BattleFlash
        key={b.id}
        x={p.x}
        y={p.y}
        color={b.winner === null ? NEUTRAL_COLOR : colorOf(meta, b.winner)}
        fade={Math.round(fade * 20) / 20}
        pulse={!reduced && fade > 0.5}
        title={`Battle at ${b.city}, ${fmtClock(b.t)}: ${winner} won${b.fell ? ", the city fell" : ""}. Open the report.`}
        onOpen={() => {
          if (report !== null) uiActions.selectReport(report);
        }}
      />
    );
  });

  // Movements --------------------------------------------------------------------------------------
  const routeViews: RouteView[] = [];
  const markerViews: MarkerView[] = [];
  const specs = new Map<string, MarkerSpec>();
  for (const m of Object.values(frame.movements)) {
    if (m === undefined) continue;
    const route = routeOf(islands, frame.cities, m);
    if (route === null) continue;
    const ally = m.kind === "attack" && againstAlly.has(m.id);
    const dim = dimOf(m.owner);
    const color = colorOf(meta, m.owner);
    const n = unitCount(m.units);
    const small = m.kind === "shipment" || m.kind === "found" || m.kind === "spy";
    routeViews.push({ id: m.id, kind: m.kind, route, color, againstAlly: ally, dim });
    const targetOwner = m.to === null ? null : (frame.cities[m.to]?.owner ?? null);
    const target =
      m.to === null
        ? m.toIsland
        : targetOwner === null || targetOwner === m.owner
          ? m.to
          : `${m.to} (${labelOf(meta, targetOwner)})`;
    markerViews.push({
      id: m.id,
      kind: m.kind,
      color,
      shape: shapeOf(meta, m.owner).d,
      r: small ? 2.4 : markerRadius(n),
      againstAlly: ally,
      dim,
      title: `${labelOf(meta, m.owner)}: ${ally ? "attack on an ally, " : ""}${KIND_WORDS[m.kind] ?? m.kind} ${target}; ${unitsText(skin, m.units)}; arrives ${fmtClock(m.arriveAt)}`,
    });
    specs.set(m.id, { route, departAt: m.departAt, arriveAt: m.arriveAt });
  }

  // The animation loop's view of the markers: their elements (set at commit) and routes.
  const markerEls = useRef(new Map<string, SVGGElement>());
  const markerSpecs = useRef<ReadonlyMap<string, MarkerSpec>>(new Map());
  const setRef = useCallback((id: string, el: SVGGElement | null) => {
    if (el === null) markerEls.current.delete(id);
    else markerEls.current.set(id, el);
  }, []);
  const place = useCallback((t: number) => {
    for (const [id, s] of markerSpecs.current) {
      const el = markerEls.current.get(id);
      if (el === undefined) continue;
      const p = markerAt(s.route, s.departAt, s.arriveAt, t);
      el.setAttribute(
        "transform",
        `translate(${Math.round(p.x * 100) / 100} ${Math.round(p.y * 100) / 100})`,
      );
    }
  }, []);

  // After every render: the routes of this frame, at the exact playhead. With reduced motion the
  // markers do not glide: while playing they jump once per game hour, paused they sit exactly.
  const playing = useMatch((s) => s.playing);
  const steppedT = reduced && playing ? Math.floor(playhead / HOUR) * HOUR : playhead;
  useLayoutEffect(() => {
    markerSpecs.current = specs;
    place(reduced ? steppedT : playheadNow());
  });
  useTick((t) => {
    if (!reduced) place(t);
  });

  const cityCount = Object.keys(frame.cities).length;
  const moving = markerViews.length;
  return (
    <div ref={boxRef} className="bg-sea-deep relative size-full overflow-hidden rounded-xl border">
      <svg
        ref={svgRef}
        data-map=""
        aria-label={`Map at ${fmtClock(playhead)}: ${meta.map.islands.length} islands, ${cityCount} cities, ${moving} ${moving === 1 ? "army or convoy" : "armies and convoys"} on the move. Select a city for its details.`}
        viewBox={`0 0 ${W} ${H}`}
        className={cn("size-full select-none", zp.zoomed ? "touch-none" : "touch-pan-y")}
      >
        <defs>
          <radialGradient
            id="map-sea"
            gradientUnits="userSpaceOnUse"
            cx={W / 2}
            cy={H / 2}
            r={Math.max(W, H) * 0.7}
          >
            <stop offset="0%" stopColor="oklch(0.24 0.05 235)" />
            <stop offset="100%" stopColor="var(--sea-deep)" />
          </radialGradient>
        </defs>
        {/* Wider than the view box: the sea fills the whole box, whatever its shape. */}
        <rect x={-W} y={-H} width={3 * W} height={3 * H} fill="url(#map-sea)" />
        <g ref={groupRef}>
          <IslandsLayer islands={meta.map.islands} tints={tints} skin={skin} />
          <g>
            {routeViews.map((v) => (
              <RouteLine key={v.id} v={v} />
            ))}
          </g>
          <g>{flashes}</g>
          <g>
            {markerViews.map((v) => (
              <Marker key={v.id} v={v} setRef={setRef} />
            ))}
          </g>
          <g>{cityMarks}</g>
        </g>
      </svg>
      <div className="absolute right-2 bottom-2 flex flex-col gap-1">
        <Button
          size="icon-sm"
          variant="secondary"
          aria-label="Zoom in"
          title="Zoom in (or scroll, pinch, double-click)"
          onClick={() => zp.zoomBy(1.6)}
        >
          <Plus />
        </Button>
        <Button
          size="icon-sm"
          variant="secondary"
          aria-label="Zoom out"
          title="Zoom out"
          disabled={!zp.zoomed}
          onClick={() => zp.zoomBy(1 / 1.6)}
        >
          <Minus />
        </Button>
        {zp.zoomed ? (
          <Button
            size="icon-sm"
            variant="secondary"
            aria-label="Show the whole map"
            title="Show the whole map"
            onClick={() => zp.reset()}
          >
            <Maximize2 />
          </Button>
        ) : null}
      </div>
      <div className="absolute top-2 right-2 flex max-w-[calc(100%-1rem)] flex-col items-end gap-1">
        <Button
          size={layout === "desktop" ? "sm" : "icon-sm"}
          variant="secondary"
          className={cn("opacity-90", layout === "desktop" && "h-7 gap-1 px-2 text-xs")}
          aria-expanded={keyOpen}
          aria-label="Map key"
          title="What the map's symbols mean"
          onClick={() => setKeyOpen((o) => !o)}
        >
          <Info aria-hidden="true" />
          {layout === "desktop" ? "Map key" : null}
        </Button>
        {keyOpen ? <MapKey frame={frame} /> : null}
      </div>
      <CityPopover svgRef={svgRef} islands={islands} />
      <ReportDialog />
    </div>
  );
}
