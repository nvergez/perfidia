import { Clapperboard, Loader2, Pause, Play, SkipBack, SkipForward, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { PlayerLabel } from "../common/player-label.tsx";
import { cn } from "../lib/cn.ts";
import { fmtClock } from "../lib/time.ts";
import { useLayout, useMatch, useUi } from "../store/hooks.ts";
import { useMatchStore } from "../store/match.ts";
import { controls, playheadNow } from "../store/session.ts";
import { uiActions } from "../store/ui.ts";
import { Button } from "../ui/button.tsx";
import { momentColor, momentWord } from "./moment-style.ts";
import { clearReelFocus, setReelFocus } from "./reel-focus.ts";
import {
  captionAt,
  planReel,
  REEL_SPEED,
  reelGoto,
  reelStart,
  reelStep,
  type ReelPlan,
  type ReelState,
} from "./reel.ts";

// The key moments reel (phase-3 design §4.3): the match's key moments one after the other, each
// played from two hours before at 1 h/s to half an hour after, then held with its caption; about
// two minutes in all. It runs while `uiStore.reelActive` is set (`?reel=1`, once "How to watch" is
// closed) and ends by itself, with Stop, Escape, or when the viewer seeks elsewhere. The map rings
// the moment's cities and dims the other players meanwhile.

interface Running {
  readonly plan: ReelPlan;
  readonly state: ReelState;
}

function Reel() {
  const layout = useLayout();
  // Planned once, from the moments and the end of what the replay holds.
  const [run, setRun] = useState<Running>(() => {
    const s = useMatchStore.getState();
    const plan = planReel(s.moments, Math.max(s.loaded.toT, s.frame?.t ?? 0));
    return { plan, state: reelStart(plan) };
  });
  const runRef = useRef<Running | null>(null);
  const [now, setNow] = useState(0);
  const playing = useMatch((s) => s.playing);
  const playhead = useMatch((s) => s.playhead);

  // The loop steps the reel on every animation frame; the speed is restored at the end.
  useEffect(() => {
    runRef.current = run;
    const speedBefore = useMatchStore.getState().speed;
    let raf = 0;
    const loop = (): void => {
      raf = window.requestAnimationFrame(loop);
      const cur = runRef.current;
      if (cur === null) return;
      const st = useMatchStore.getState();
      const t = performance.now();
      const { state, cmd } = reelStep(cur.plan, cur.state, {
        now: t,
        playhead: playheadNow(),
        playing: st.playing,
        known: st.known,
        complete: st.loaded.complete,
      });
      if (cmd.k === "start") {
        controls.seek(cmd.t);
        controls.setSpeed(REEL_SPEED);
        controls.play();
      } else if (cmd.k === "pause") {
        controls.pause();
      } else if (cmd.k === "stop") {
        uiActions.stopReel();
        return;
      }
      if (state !== cur.state) {
        const next = { plan: cur.plan, state };
        runRef.current = next;
        setRun(next);
      }
      if (state.k === "hold") setNow(Math.floor(t / 100) * 100);
    };
    raf = window.requestAnimationFrame(loop);
    // Not the Escape that closed "How to watch" and so started the reel.
    const mountedAt = performance.now();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape" && e.timeStamp > mountedAt) uiActions.stopReel();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.cancelAnimationFrame(raf);
      window.removeEventListener("keydown", onKey);
      runRef.current = null;
      clearReelFocus();
      controls.setSpeed(speedBefore);
    };
    // Started once per reel: later states go through `runRef`.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const goto = (n: number): void => {
    const cur = runRef.current;
    if (cur === null) return;
    const state = reelGoto(cur.plan, n);
    if (state.k === "done") {
      uiActions.stopReel();
      return;
    }
    const next = { plan: cur.plan, state };
    runRef.current = next;
    setRun(next);
  };

  const { plan, state } = run;
  const index = state.k === "done" ? -1 : state.clip;
  const clip = plan.clips[index];
  const caption = clip === undefined ? null : captionAt(clip, playhead);

  const focus = caption !== null && caption.past ? caption.moment : null;
  useEffect(() => {
    if (focus === null) clearReelFocus();
    else setReelFocus(focus.cities, focus.players);
  }, [focus]);

  const total = plan.clips.length;
  const holdLeft =
    state.k === "hold"
      ? Math.max(0, Math.min(1, (state.until - now) / Math.max(1, plan.holdMs)))
      : null;
  return (
    <section
      aria-label="Key moments reel"
      className={cn(
        "bg-popover/95 text-popover-foreground fixed inset-x-3 z-40 mx-auto flex max-w-xl flex-col gap-2 rounded-xl border p-3 shadow-xl backdrop-blur-sm",
        layout === "phone" ? "bottom-28" : "bottom-24",
      )}
    >
      <header className="flex items-center gap-2 text-xs">
        <Clapperboard className="text-gold size-4" aria-hidden="true" />
        <span className="font-medium">Key moments</span>
        <span className="text-muted-foreground tabular-nums">
          {total === 0 ? "none in this match" : `${Math.min(total, index + 1)} of ${total}`}
        </span>
        <span className="ml-auto flex items-center gap-0.5">
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Previous moment"
            disabled={index <= 0}
            onClick={() => goto(index - 1)}
          >
            <SkipBack />
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={playing ? "Pause the reel" : "Resume the reel"}
            disabled={state.k !== "play"}
            onClick={() => (playing ? controls.pause() : controls.play())}
          >
            {playing ? <Pause /> : <Play />}
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Next moment"
            disabled={total === 0}
            onClick={() => goto(index + 1)}
          >
            <SkipForward />
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Stop the reel"
            title="Stop the reel (Escape)"
            onClick={() => uiActions.stopReel()}
          >
            <X />
          </Button>
        </span>
      </header>
      {state.k === "wait" ? (
        <p className="text-muted-foreground flex items-center gap-2 text-sm">
          <Loader2 className="size-4 motion-safe:animate-spin" aria-hidden="true" /> Loading the
          match…
        </p>
      ) : caption === null ? null : (
        <div className="flex flex-col gap-1.5" aria-live="polite">
          <p className="flex items-center gap-2 text-xs">
            <span
              className="size-2.5 rotate-45 rounded-[1px]"
              style={{
                background: momentColor(
                  caption.moment.k,
                  caption.moment.k === "launch" && caption.moment.importance >= 3,
                ),
              }}
              aria-hidden="true"
            />
            <span className="font-medium">{momentWord(caption.moment.k)}</span>
            <span className="text-muted-foreground font-mono">{fmtClock(caption.moment.t)}</span>
            {caption.past ? null : <span className="text-muted-foreground">· coming up</span>}
          </p>
          <p className={cn("font-serif text-base leading-snug", !caption.past && "opacity-60")}>
            {caption.moment.title}
          </p>
          {caption.moment.players.length === 0 ? null : (
            <p className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
              {caption.moment.players.slice(0, 4).map((p) => (
                <PlayerLabel key={p} player={p} />
              ))}
            </p>
          )}
        </div>
      )}
      <div className="bg-secondary h-1 overflow-hidden rounded-full" aria-hidden="true">
        <div
          className="bg-gold h-full"
          style={{
            width: `${total === 0 ? 100 : ((index + (holdLeft === null ? 0 : 1 - holdLeft)) / total) * 100}%`,
          }}
        />
      </div>
    </section>
  );
}

export function KeyMomentsReel() {
  const active = useUi((s) => s.reelActive);
  const ready = useMatch((s) => s.phase === "ready");
  return active && ready ? <Reel /> : null;
}
