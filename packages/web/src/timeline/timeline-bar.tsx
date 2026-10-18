import { Pause, Play, SkipBack, SkipForward } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { cn } from "../lib/cn.ts";
import { fmtClock, fmtSpeed, SPEEDS } from "../lib/time.ts";
import { useLayout, useMatch, useTick } from "../store/hooks.ts";
import { controls, isRunningStatus, playheadNow } from "../store/session.ts";
import { Button } from "../ui/button.tsx";
import { focusKind, keyCommand, type KeyCommand } from "./keys.ts";
import { Scrubber } from "./scrubber.tsx";

// The timeline (phase-3 design §4.3 "Timeline"): play and pause, the previous and next key moment,
// the game clock, the scrubber, the speed (5 min/s to 6 h/s) and, while the match runs, LIVE (at
// the head) or "Go live" (catch up). Keyboard: Space, ←/→ (moments), +/− (speed). One bar is
// mounted at a time (one layout), so the shortcuts are bound once.

const RUN: Readonly<Record<KeyCommand, () => void>> = Object.freeze({
  toggle: () => controls.toggle(),
  prev: () => controls.prevMoment(),
  next: () => controls.nextMoment(),
  faster: () => controls.faster(),
  slower: () => controls.slower(),
});

function useShortcuts(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.defaultPrevented || e.repeat) return;
      const target = e.target instanceof Element ? e.target : null;
      const cmd = keyCommand(e, focusKind(target));
      if (cmd === null) return;
      e.preventDefault();
      RUN[cmd]();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

/** The game clock, written from the exact playhead on every animation frame. */
function Clock() {
  const ref = useRef<HTMLSpanElement>(null);
  // Subscribed so the clock re-renders (and re-reads the exact playhead) when the store's moves.
  useMatch((s) => s.playhead);
  const write = useCallback((t: number) => {
    const text = fmtClock(t);
    if (ref.current !== null && ref.current.textContent !== text) ref.current.textContent = text;
  }, []);
  // After every render (the store's playhead changed): the exact playhead.
  useLayoutEffect(() => {
    write(playheadNow());
  });
  useTick(write);
  return (
    <span
      ref={ref}
      role="timer"
      aria-live="off"
      aria-label="Game time"
      className="min-w-[5.6rem] font-mono text-base font-semibold tabular-nums"
    />
  );
}

function LiveButton() {
  const mode = useMatch((s) => s.mode);
  const running = useMatch((s) => isRunningStatus(s.status));
  if (!running) return null;
  if (mode === "live") {
    return (
      <span
        className="border-live/50 text-live inline-flex h-8 items-center gap-1.5 rounded-md border px-2 text-xs font-semibold tracking-wide"
        title="You are watching the match as it happens"
      >
        <span
          className="bg-live size-2 rounded-full motion-safe:animate-pulse"
          aria-hidden="true"
        />
        LIVE
      </span>
    );
  }
  return (
    <Button
      size="sm"
      variant="outline"
      className="text-live border-live/50 h-8 gap-1.5 text-xs font-semibold"
      onClick={() => controls.goLive()}
      title="Catch up with the match as it happens"
    >
      <span className="bg-live size-2 rounded-full" aria-hidden="true" />
      Go live
    </Button>
  );
}

function SpeedSelect() {
  const speed = useMatch((s) => s.speed);
  const live = useMatch((s) => s.mode === "live");
  return (
    <select
      aria-label="Replay speed"
      title="Replay speed: game time per second (+ and − keys)"
      disabled={live}
      className="bg-secondary text-secondary-foreground h-8 shrink-0 rounded-md border px-1.5 text-sm tabular-nums disabled:opacity-50"
      value={SPEEDS.some((s) => s === speed) ? speed : ""}
      onChange={(e) => controls.setSpeed(Number(e.target.value))}
    >
      {SPEEDS.some((s) => s === speed) ? null : <option value="">{fmtSpeed(speed)}</option>}
      {SPEEDS.map((s) => (
        <option key={s} value={s}>
          {fmtSpeed(s)}
        </option>
      ))}
    </select>
  );
}

function Transport() {
  const playing = useMatch((s) => s.playing);
  const hasMoments = useMatch((s) => s.moments.length > 0);
  return (
    <div className="flex shrink-0 items-center gap-1">
      <Button
        size="icon-sm"
        variant="ghost"
        aria-label="Previous key moment"
        title="Previous key moment (←)"
        disabled={!hasMoments}
        onClick={() => controls.prevMoment()}
      >
        <SkipBack />
      </Button>
      <Button
        size="icon-sm"
        variant="default"
        aria-label={playing ? "Pause" : "Play"}
        title={playing ? "Pause (Space)" : "Play (Space)"}
        onClick={() => controls.toggle()}
      >
        {playing ? <Pause /> : <Play />}
      </Button>
      <Button
        size="icon-sm"
        variant="ghost"
        aria-label="Next key moment"
        title="Next key moment (→)"
        disabled={!hasMoments}
        onClick={() => controls.nextMoment()}
      >
        <SkipForward />
      </Button>
    </div>
  );
}

export function TimelineBar() {
  const phone = useLayout() === "phone";
  useShortcuts();
  return (
    <section
      aria-label="Timeline"
      data-timeline=""
      className={cn(
        "bg-card flex items-center gap-x-3 rounded-xl border px-3",
        phone ? "flex-wrap gap-y-0 py-1" : "py-1.5",
      )}
    >
      {phone ? <Scrubber className="order-first w-full basis-full" /> : null}
      <Transport />
      <Clock />
      {phone ? <span className="flex-1" /> : <Scrubber className="flex-1" />}
      <SpeedSelect />
      <LiveButton />
    </section>
  );
}
