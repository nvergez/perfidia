// oxlint-disable jsx-a11y/prefer-tag-over-role -- a custom slider (moment glyphs, snapping to them) with the ARIA slider keys
import type { Moment } from "@perfidia/protocol/spectator";
import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import { MomentTitle } from "../common/moment-title.tsx";
import { cn } from "../lib/cn.ts";
import { DAY, HOUR, MINUTE, fmtClock } from "../lib/time.ts";
import { useMatch, useMoments, usePlayhead, useTick } from "../store/hooks.ts";
import { controls, playheadNow } from "../store/session.ts";
import { momentColor, momentWord } from "./moment-style.ts";

// The scrubber (phase-3 design §4.3 "Timeline"): the whole match from D1 00:00 to its end, day
// ticks, the key moments as glyphs coloured by kind (taller for importance 3), the part not played
// (yet) hatched. Click or drag to seek; a click next to a glyph goes to that moment exactly. As a
// slider: ←/→ 15 game minutes (Shift: 1), Page Up/Down 6 hours, Home, End. The thumb follows the
// exact playhead on every animation frame through refs.

const SNAP_PX = 7;
const DRAG_PX = 3;

interface Hover {
  readonly x: number;
  readonly t: number;
  readonly moment: Moment | null;
}

export function Scrubber({ className }: { readonly className?: string }) {
  const matchEnd = useMatch((s) => s.meta?.matchEnd ?? 0);
  const limit = useMatch((s) => s.loaded.toT);
  const playhead = usePlayhead();
  const moments = useMoments();
  const span = Math.max(1, matchEnd, limit);
  const track = useRef<HTMLDivElement>(null);
  const fill = useRef<HTMLDivElement>(null);
  const thumb = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<Hover | null>(null);
  /** Where the pointer went down while it is down: a drag starts beyond a few pixels from it. */
  const down = useRef<{ x: number; moved: boolean } | null>(null);

  const share = useCallback((t: number) => Math.min(1, Math.max(0, t / span)), [span]);
  const place = useCallback(
    (t: number) => {
      const p = `${share(t) * 100}%`;
      if (fill.current !== null) fill.current.style.width = p;
      if (thumb.current !== null) thumb.current.style.left = p;
    },
    [share],
  );
  useLayoutEffect(() => place(playheadNow()));
  useTick(place);

  const days = useMemo(() => {
    const out: number[] = [];
    for (let d = 0; d * DAY < span; d += 1) out.push(d);
    return out;
  }, [span]);

  const at = (clientX: number): { t: number; x: number; width: number } | null => {
    const r = track.current?.getBoundingClientRect();
    if (r === undefined || r.width <= 0) return null;
    const x = Math.min(r.width, Math.max(0, clientX - r.left));
    return { t: Math.round((x / r.width) * span), x, width: r.width };
  };

  const nearest = (x: number, width: number): Moment | null => {
    let best: Moment | null = null;
    let bestD = SNAP_PX + 1;
    for (const m of moments) {
      const d = Math.abs((m.t / span) * width - x) - (m.importance >= 3 ? 1 : 0);
      if (d < bestD) {
        best = m;
        bestD = d;
      }
    }
    return bestD <= SNAP_PX ? best : null;
  };

  const seekTo = (t: number): void => controls.seek(Math.min(Math.max(0, limit), Math.max(0, t)));

  const onDown = (e: PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return;
    const p = at(e.clientX);
    if (p === null) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    down.current = { x: p.x, moved: false };
    const m = nearest(p.x, p.width);
    if (m !== null) controls.seekSeq(m.seq, m.t);
    else seekTo(p.t);
  };
  const onMove = (e: PointerEvent<HTMLDivElement>): void => {
    const p = at(e.clientX);
    if (p === null) return;
    const d = down.current;
    if (d !== null) {
      if (!d.moved && Math.abs(p.x - d.x) < DRAG_PX) return;
      d.moved = true;
      seekTo(p.t);
      setHover({ x: p.x, t: p.t, moment: null });
      return;
    }
    if (e.pointerType === "mouse") setHover({ x: p.x, t: p.t, moment: nearest(p.x, p.width) });
  };
  const onUp = (): void => {
    down.current = null;
  };

  const onKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    const now = playheadNow();
    const small = e.shiftKey ? MINUTE : 15 * MINUTE;
    const step: Readonly<Record<string, number>> = {
      ArrowLeft: -small,
      ArrowDown: -small,
      ArrowRight: small,
      ArrowUp: small,
      PageDown: -6 * HOUR,
      PageUp: 6 * HOUR,
    };
    if (e.key === "Home") seekTo(0);
    else if (e.key === "End") seekTo(limit);
    else if (step[e.key] !== undefined) seekTo(now + (step[e.key] ?? 0));
    else return;
    e.preventDefault();
  };

  const playedTo = share(limit);
  return (
    <div className={cn("relative min-w-0 pt-3 pb-4", className)}>
      <div
        ref={track}
        role="slider"
        tabIndex={0}
        aria-label="Game time"
        aria-valuemin={0}
        aria-valuemax={Math.max(0, limit)}
        aria-valuenow={Math.round(playhead)}
        aria-valuetext={fmtClock(playhead)}
        className="group focus-visible:ring-ring/50 relative h-5 cursor-pointer touch-none rounded-sm outline-none focus-visible:ring-[3px]"
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onPointerLeave={() => setHover(null)}
        onKeyDown={onKey}
      >
        <div className="bg-secondary absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 overflow-hidden rounded-full">
          {playedTo < 1 ? (
            <div
              aria-hidden="true"
              className="absolute inset-y-0 right-0 bg-[repeating-linear-gradient(135deg,transparent_0_3px,oklch(0.4_0.03_250/0.6)_3px_5px)]"
              style={{ left: `${playedTo * 100}%` }}
            />
          ) : null}
          <div ref={fill} className="bg-primary/80 absolute inset-y-0 left-0" />
        </div>
        {days.map((d) =>
          d === 0 ? null : (
            <div
              key={d}
              aria-hidden="true"
              className="bg-muted-foreground/50 absolute top-0.5 bottom-0.5 w-px"
              style={{ left: `${share(d * DAY) * 100}%` }}
            />
          ),
        )}
        {moments.map((m) => (
          <div
            key={m.item}
            aria-hidden="true"
            className={cn(
              "pointer-events-none absolute -translate-x-1/2",
              m.importance >= 3
                ? "-top-2.5 size-2 rotate-45 rounded-[1px] ring-1 ring-black/50"
                : "-top-1.5 h-1.5 w-0.5 rounded-full",
            )}
            style={{
              left: `${share(m.t) * 100}%`,
              background: momentColor(m.k, m.k === "launch" && m.importance >= 3),
            }}
          />
        ))}
        <div
          ref={thumb}
          aria-hidden="true"
          className="bg-foreground border-primary pointer-events-none absolute top-1/2 size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 shadow"
        />
      </div>
      <div
        aria-hidden="true"
        className="text-muted-foreground pointer-events-none absolute inset-x-0 bottom-0 h-3 text-[10px] leading-none"
      >
        {days.map((d) => (
          <span
            key={d}
            className="absolute pl-0.5 font-mono"
            style={{ left: `${share(d * DAY) * 100}%` }}
          >
            {share((d + 1) * DAY) - share(d * DAY) > 0.045 ? `D${d + 1}` : ""}
          </span>
        ))}
      </div>
      {hover === null ? null : (
        <div
          aria-hidden="true"
          className="bg-popover text-popover-foreground pointer-events-none absolute bottom-full z-20 mb-1 max-w-64 -translate-x-1/2 rounded-md border px-2 py-1 text-xs whitespace-nowrap shadow-md"
          style={{ left: hover.x }}
        >
          {hover.moment === null ? (
            <span className="font-mono">{fmtClock(hover.t)}</span>
          ) : (
            <span className="flex flex-col">
              <span className="text-muted-foreground font-mono">
                {fmtClock(hover.moment.t)} · {momentWord(hover.moment.k)}
              </span>
              <span className="truncate">
                <MomentTitle title={hover.moment.title} />
              </span>
            </span>
          )}
        </div>
      )}
    </div>
  );
}
