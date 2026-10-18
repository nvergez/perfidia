import { ChevronLeft, ChevronRight, Pause, Play, Radio } from "lucide-react";
import { fmtClock, fmtSpeed, SPEEDS } from "../lib/time.ts";
import { controls } from "../store/session.ts";
import { useMatch } from "../store/hooks.ts";
import { Button } from "../ui/button.tsx";
import { Slider } from "../ui/slider.tsx";

// STUB (owned by view agent A, phase-3 design §4.3 "Timeline"): play and pause, the clock, a plain
// scrubber, the speed, previous and next moment, LIVE. Agent A replaces this file (day ticks, moment
// glyphs, keyboard); the export name and the no-props signature stay.

export function TimelineBar() {
  const playhead = useMatch((s) => s.playhead);
  const playing = useMatch((s) => s.playing);
  const mode = useMatch((s) => s.mode);
  const speed = useMatch((s) => s.speed);
  const end = useMatch((s) => s.meta?.matchEnd ?? 0);
  const running = useMatch(
    (s) => s.status === "live" || s.status === "paused" || s.status === "stalled",
  );
  return (
    <div
      data-stub="timeline"
      className="bg-card flex flex-wrap items-center gap-2 rounded-xl border px-3 py-2"
    >
      <Button
        size="icon-sm"
        variant="secondary"
        aria-label={playing ? "Pause" : "Play"}
        onClick={() => controls.toggle()}
      >
        {playing ? <Pause /> : <Play />}
      </Button>
      <Button
        size="icon-sm"
        variant="ghost"
        aria-label="Previous moment"
        onClick={() => controls.prevMoment()}
      >
        <ChevronLeft />
      </Button>
      <Button
        size="icon-sm"
        variant="ghost"
        aria-label="Next moment"
        onClick={() => controls.nextMoment()}
      >
        <ChevronRight />
      </Button>
      <span className="font-mono text-sm tabular-nums" aria-live="off">
        {fmtClock(playhead)}
      </span>
      <Slider
        className="min-w-32 flex-1"
        min={0}
        max={Math.max(1, end)}
        step={60}
        value={[Math.min(playhead, end)]}
        onValueChange={(v) => controls.seek(v[0] ?? 0)}
        aria-label="Game time"
      />
      <select
        aria-label="Speed"
        className="bg-secondary text-secondary-foreground h-8 rounded-md border px-2 text-sm"
        value={speed}
        onChange={(e) => controls.setSpeed(Number(e.target.value))}
      >
        {SPEEDS.map((s) => (
          <option key={s} value={s}>
            {fmtSpeed(s)}
          </option>
        ))}
      </select>
      {running ? (
        <Button
          size="sm"
          variant={mode === "live" ? "destructive" : "outline"}
          onClick={() => controls.goLive()}
        >
          <Radio /> Live
        </Button>
      ) : null}
    </div>
  );
}
