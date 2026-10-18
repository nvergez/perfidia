import type { CityEnt, Frame, QueueEnt, SpectatorIsland } from "@perfidia/protocol/spectator";
import { Eye, Hourglass, Landmark, ScrollText, Swords, X } from "lucide-react";
import { Popover } from "radix-ui";
import { useEffect, useLayoutEffect, useMemo, useRef, type ReactNode, type RefObject } from "react";
import { GameTime } from "../common/game-time.tsx";
import { PlayerLabel } from "../common/player-label.tsx";
import { SkinIconView } from "../common/skin-icon.tsx";
import { fmtInt } from "../lib/format.ts";
import type { PlayerId } from "../lib/ids.ts";
import { stockNow } from "../lib/stock.ts";
import { fmtSpan } from "../lib/time.ts";
import type { Skin } from "../skins/index.ts";
import {
  useFeed,
  useFrame,
  useLayout,
  usePlayhead,
  usePrefersReducedMotion,
  useSkin,
  useUi,
} from "../store/hooks.ts";
import { uiActions } from "../store/ui.ts";
import { Badge } from "../ui/badge.tsx";
import { Button } from "../ui/button.tsx";
import type { IslandIndex } from "./geometry.ts";

// The city popover (phase-3 design §4.2.5): opened by selecting a city on the map (or from
// anywhere through `uiStore.selectedCity`), anchored to the city's marker. It shows the owner, the
// buildings and queues through the skin, the garrison by owner (what players cannot see), a siege,
// former owners, the stock extrapolated to the playhead ("≈"), and the last battle there.

const ZERO = new DOMRect(0, 0, 0, 0);

function Row({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="grid grid-cols-[6.5rem_minmax(0,1fr)] items-baseline gap-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  );
}

function Owner({ player }: { readonly player: PlayerId }) {
  return (
    <button
      type="button"
      className="hover:bg-accent -mx-1 max-w-full rounded px-1 text-left"
      onClick={() => uiActions.openPlayer(player)}
      title="Open this player's card"
    >
      <PlayerLabel player={player} model />
    </button>
  );
}

function UnitList({
  skin,
  units,
}: {
  readonly skin: Skin;
  readonly units: Readonly<Record<string, number>>;
}) {
  const entries = Object.entries(units).toSorted(
    ([a], [b]) => skin.unitOrder.indexOf(a) - skin.unitOrder.indexOf(b),
  );
  if (entries.length === 0) return <span className="text-muted-foreground">none</span>;
  return (
    <span className="flex flex-wrap gap-x-2 gap-y-0.5">
      {entries.map(([u, n]) => {
        const l = skin.unit(u);
        return (
          <span key={u} className="inline-flex items-center gap-1 tabular-nums">
            <SkinIconView icon={l.icon} className="text-muted-foreground size-3" />
            {fmtInt(n)} {(n === 1 ? l.name : l.plural).toLowerCase()}
          </span>
        );
      })}
    </span>
  );
}

function queueText(skin: Skin, q: QueueEnt): string {
  if (q.building !== null) {
    return `${skin.building(q.building).name} to level ${q.level ?? "?"}`;
  }
  if (q.unit !== null) {
    const l = skin.unit(q.unit);
    const n = q.count ?? 0;
    return `${fmtInt(n)} ${(n === 1 ? l.name : l.plural).toLowerCase()}${q.done !== null && q.done > 0 ? ` (${fmtInt(q.done)} delivered)` : ""}`;
  }
  return skin.queue(q.queue).name;
}

function CityDetails({
  city,
  frame,
  skin,
  islands,
}: {
  readonly city: CityEnt;
  readonly frame: Frame;
  readonly skin: Skin;
  readonly islands: IslandIndex<SpectatorIsland>;
}) {
  const playhead = usePlayhead();
  const feed = useFeed();
  const ext = skin.city(city);
  const kind = islands.get(city.island)?.kind;
  const island = kind === undefined ? null : skin.islandKind(kind).name;
  const queues = useMemo(
    () =>
      Object.values(frame.queues)
        .filter((q): q is QueueEnt => q !== undefined && q.city === city.id)
        .toSorted((a, b) => a.start - b.start || a.item - b.item),
    [frame.queues, city.id],
  );
  const lastBattle = useMemo(() => {
    for (let i = feed.length - 1; i >= 0; i -= 1) {
      const it = feed[i]?.item;
      if (it?.k === "battle" && it.city === city.id) return it;
    }
    return null;
  }, [feed, city.id]);
  const stock = stockNow(city, playhead);
  const buildings = Object.entries(city.buildings)
    .filter(([, lv]) => lv > 0)
    .toSorted(([a], [b]) => {
      const ia = skin.buildingOrder.indexOf(a);
      const ib = skin.buildingOrder.indexOf(b);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || (a < b ? -1 : a > b ? 1 : 0);
    });
  return (
    <div className="flex flex-col gap-3 text-sm">
      <header className="flex items-start gap-2 pr-6">
        <Landmark className="text-muted-foreground mt-0.5 size-4 shrink-0" aria-hidden="true" />
        <div className="min-w-0">
          <h2 className="font-serif text-base leading-tight">
            {city.name === city.id ? (
              <span className="font-mono">{city.id}</span>
            ) : (
              <>
                <bdi>{city.name}</bdi>{" "}
                <span className="text-muted-foreground font-mono">· {city.id}</span>
              </>
            )}
          </h2>
          <p className="text-muted-foreground text-xs">
            {island === null ? city.island : `${island} · ${city.island}`}, slot {city.slot + 1}
          </p>
        </div>
      </header>
      <div className="flex flex-wrap gap-1">
        {city.capitalOf === null ? null : <Badge variant="secondary">Capital</Badge>}
        {ext.prize && skin.prizeName !== null ? (
          <Badge className="bg-gold text-gold-foreground">{skin.prizeName}</Badge>
        ) : null}
        {ext.taken ? <Badge variant="outline">Taken by conquest</Badge> : null}
        {ext.points === null ? null : <Badge variant="outline">{fmtInt(ext.points)} points</Badge>}
      </div>
      <dl className="flex flex-col gap-1.5">
        <Row label="Owner">
          {city.owner === null ? <span>Neutral</span> : <Owner player={city.owner} />}
        </Row>
        {ext.former.length === 0 ? null : (
          <Row label="Former owners">
            <span className="flex flex-wrap gap-x-2">
              {ext.former.map((p, i, all) => (
                <PlayerLabel key={all.slice(0, i + 1).join(">")} player={p} />
              ))}
            </span>
          </Row>
        )}
        {ext.siege === null ? null : (
          <Row label="Besieged by">
            <span className="flex flex-col">
              <PlayerLabel player={ext.siege.by} />
              {ext.siege.endsAt === null ? null : (
                <span className="text-muted-foreground text-xs">
                  falls at <GameTime t={ext.siege.endsAt} /> unless relieved (
                  {fmtSpan(Math.max(0, ext.siege.endsAt - playhead))} left)
                </span>
              )}
            </span>
          </Row>
        )}
      </dl>
      <section aria-label="Garrison" className="flex flex-col gap-1.5">
        <h3 className="flex items-center gap-1 text-xs font-medium">
          <Swords className="size-3.5" aria-hidden="true" /> Garrison
          <span className="text-muted-foreground ml-auto inline-flex items-center gap-1 font-normal">
            <Eye className="size-3.5" aria-hidden="true" /> hidden from players
          </span>
        </h3>
        <dl className="flex flex-col gap-1">
          <Row label={city.owner === null ? "Neutral" : "At home"}>
            <UnitList skin={skin} units={city.units} />
          </Row>
          {city.stationed.map((g) => (
            <Row
              key={`${g.owner}-${g.home}-${g.role}`}
              label={g.role === "hold" ? "Holding it" : "Supporting"}
            >
              <span className="flex flex-col gap-0.5">
                <PlayerLabel player={g.owner} />
                <UnitList skin={skin} units={g.units} />
              </span>
            </Row>
          ))}
        </dl>
      </section>
      {buildings.length === 0 ? null : (
        <section aria-label="Buildings" className="flex flex-col gap-1">
          <h3 className="text-xs font-medium">Buildings</h3>
          <ul className="grid grid-cols-2 gap-x-3 gap-y-0.5">
            {buildings.map(([b, lv]) => {
              const l = skin.building(b);
              return (
                <li key={b} className="flex items-center gap-1">
                  <SkinIconView icon={l.icon} className="text-muted-foreground size-3" />
                  <span className="truncate">{l.name}</span>
                  <span className="ml-auto tabular-nums">{lv}</span>
                </li>
              );
            })}
          </ul>
        </section>
      )}
      {queues.length === 0 ? null : (
        <section aria-label="Queues" className="flex flex-col gap-1">
          <h3 className="flex items-center gap-1 text-xs font-medium">
            <Hourglass className="size-3.5" aria-hidden="true" /> Queues
          </h3>
          <ul className="flex flex-col gap-0.5">
            {queues.map((q) => (
              <li key={`${q.city}#${q.item}`} className="flex gap-2">
                <span className="text-muted-foreground w-24 shrink-0 truncate">
                  {skin.queue(q.queue).name}
                </span>
                <span className="min-w-0 flex-1">{queueText(skin, q)}</span>
                <GameTime
                  t={q.end}
                  className="text-muted-foreground shrink-0 text-xs tabular-nums"
                />
              </li>
            ))}
          </ul>
        </section>
      )}
      <section aria-label="Stock" className="flex flex-col gap-1">
        <h3 className="text-xs font-medium">
          Stock{" "}
          <span className="text-muted-foreground font-normal">
            ≈ now, storage {fmtInt(city.cap)}
          </span>
        </h3>
        <ul className="flex flex-wrap gap-x-3 gap-y-0.5">
          {Object.entries(city.perHour).map(([r, rate]) => {
            const l = skin.resource(r);
            return (
              <li key={r} className="inline-flex items-center gap-1 tabular-nums">
                <SkinIconView icon={l.icon} className="text-muted-foreground size-3" />≈
                {fmtInt(stock[r] ?? 0)} {l.name.toLowerCase()}
                <span className="text-muted-foreground text-xs">+{fmtInt(rate)}/h</span>
              </li>
            );
          })}
        </ul>
        <p className="text-muted-foreground text-xs tabular-nums">
          Population {fmtInt(city.pop.used)} of {fmtInt(city.pop.cap)}
        </p>
      </section>
      {lastBattle === null || lastBattle.reports[0] === undefined ? null : (
        <Button
          size="sm"
          variant="secondary"
          className="self-start"
          onClick={() => uiActions.selectReport(lastBattle.reports[0] ?? null)}
        >
          <ScrollText aria-hidden="true" /> Last battle here, <GameTime t={lastBattle.t} />
        </Button>
      )}
    </div>
  );
}

export function CityPopover({
  svgRef,
  islands,
}: {
  readonly svgRef: RefObject<SVGSVGElement | null>;
  readonly islands: IslandIndex<SpectatorIsland>;
}) {
  const selected = useUi((s) => s.selectedCity);
  const frame = useFrame();
  const skin = useSkin();
  const reduced = usePrefersReducedMotion();
  const desktop = useLayout() === "desktop";
  const city = selected === null || frame === null ? undefined : frame.cities[selected];
  const anchor = useRef({
    getBoundingClientRect: (): DOMRect => {
      const id = selectedRef.current;
      if (id === null) return ZERO;
      const el = svgRef.current?.querySelector(`[data-city="${id}"] [data-shape]`);
      return el?.getBoundingClientRect() ?? svgRef.current?.getBoundingClientRect() ?? ZERO;
    },
  });
  const selectedRef = useRef<string | null>(selected);
  useLayoutEffect(() => {
    selectedRef.current = selected;
  }, [selected]);

  // Selected from elsewhere (the feed) while the map is scrolled away: bring it into view.
  useEffect(() => {
    if (selected === null) return;
    const svg = svgRef.current;
    if (svg === null) return;
    const r = svg.getBoundingClientRect();
    if (r.bottom < 0 || r.top > window.innerHeight) {
      svg.scrollIntoView({ block: "nearest", behavior: reduced ? "auto" : "smooth" });
    }
  }, [selected, svgRef, reduced]);

  const open = city !== undefined && skin !== null && frame !== null;
  return (
    <Popover.Root
      open={open}
      onOpenChange={(o) => {
        if (!o) uiActions.selectCity(null);
      }}
    >
      <Popover.Anchor virtualRef={anchor} />
      <Popover.Portal>
        <Popover.Content
          side={desktop ? "right" : "bottom"}
          align="center"
          sideOffset={10}
          collisionPadding={8}
          updatePositionStrategy="always"
          aria-label={selected === null ? "City" : `City ${selected}`}
          className="bg-popover text-popover-foreground data-[state=open]:animate-in data-[state=open]:fade-in-0 z-50 max-h-[min(34rem,var(--radix-popover-content-available-height))] w-[min(22rem,calc(100vw-1rem))] overflow-y-auto rounded-lg border p-3 shadow-lg outline-hidden [scrollbar-width:thin]"
        >
          {open ? <CityDetails city={city} frame={frame} skin={skin} islands={islands} /> : null}
          <Popover.Close
            aria-label="Close"
            className="hover:bg-accent absolute top-2 right-2 rounded p-1 opacity-70 hover:opacity-100"
          >
            <X className="size-4" />
          </Popover.Close>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
