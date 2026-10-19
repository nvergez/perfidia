import { describe, expect, test } from "bun:test";
import type { Moment } from "@perfidia/protocol/spectator";
import {
  AFTER_S,
  BEFORE_S,
  captionAt,
  planReel,
  reelGoto,
  reelMoments,
  reelStart,
  reelStep,
  type ReelInput,
  type ReelState,
} from "./reel.ts";

const H = 3_600;

let n = 0;
/** A moment at a game hour; cursors follow time, as in a log. */
function moment(hour: number, importance: 2 | 3, k: Moment["k"] = "battle"): Moment {
  n += 1;
  const seq = Math.round(hour * H) * 10 + (n % 10);
  return {
    item: `${seq}:0`,
    seq,
    t: Math.round(hour * H),
    k,
    importance,
    title: `${k} at ${hour}h`,
    players: [],
    cities: [],
  };
}

/** The war golden's key moments (importance 3), by game hour. */
const WAR = [
  moment(80, 3, "launch"),
  moment(84, 3, "diplomacy"),
  moment(84, 3, "betrayal"),
  moment(111, 3, "conquest"),
  moment(114, 3, "conquest"),
  moment(114, 3, "countdown"),
  moment(130, 3, "conquest"),
  moment(138.5, 3, "end"),
];
const WAR_END = Math.round(138.5 * H);

describe("the reel's moments", () => {
  test("eight key moments or more: only those", () => {
    const all = [moment(10, 2), ...WAR, moment(140, 2)];
    expect(reelMoments(all)).toEqual(WAR);
  });

  test("fewer than eight: importance 2 joins in, spread over the match, in time order", () => {
    const twos = Array.from({ length: 40 }, (_, i) => moment(i * 3, 2));
    const key = moment(50.5, 3, "betrayal");
    const got = reelMoments([...twos, key].toSorted((a, b) => a.seq - b.seq));
    expect(got).toHaveLength(16);
    expect(got).toContain(key);
    expect(got[0]).toBe(twos[0]);
    expect(got.at(-1)).toBe(twos.at(-1));
    for (let i = 1; i < got.length; i += 1) {
      expect(got[i]?.seq ?? 0).toBeGreaterThan(got[i - 1]?.seq ?? 0);
    }
  });
});

describe("the plan", () => {
  test("a clip runs from two hours before each moment to half an hour after", () => {
    const plan = planReel(WAR, WAR_END);
    const hours = plan.clips.map((c) => [c.from / H, c.to / H, c.moments.length]);
    expect(hours).toEqual([
      [78, 80.5, 1],
      [82, 84.5, 2],
      [109, 111.5, 1],
      [112, 114.5, 2],
      [128, 130.5, 1],
      [136.5, 138.5, 1],
    ]);
  });

  test("clips that overlap merge; the first starts no earlier than 0", () => {
    const plan = planReel([moment(1, 3), moment(2, 3), moment(3.4, 3)], 100 * H);
    expect(plan.clips).toHaveLength(1);
    expect(plan.clips[0]?.from).toBe(0);
    expect(plan.clips[0]?.to).toBe(3.4 * H + AFTER_S);
  });

  test("holds are sized for about two minutes, between 4 and 9 seconds each", () => {
    const plan = planReel(WAR, WAR_END);
    expect(plan.holdMs).toBe(9_000);
    // 5 clips of 2.5 game hours and one of 2 at 1 h/s, then 6 holds.
    expect(plan.totalMs).toBe(14_500 + 6 * 9_000);
    const many = planReel(
      Array.from({ length: 16 }, (_, i) => moment(i * 10, 3)),
      200 * H,
    );
    // One clip of half an hour (the first moment is at 0) and 15 of 2.5 hours: 38 s of play.
    expect(many.holdMs).toBe(Math.round((120_000 - 38_000) / 16));
    expect(planReel([], 10).clips).toEqual([]);
  });
});

const at = (o: Partial<ReelInput>): ReelInput => ({
  now: 0,
  playhead: 0,
  playing: false,
  known: true,
  complete: true,
  ...o,
});

describe("playing the reel", () => {
  const plan = planReel(WAR, WAR_END);

  test("waits for the match to load, seeks to the clip, plays, holds, moves on", () => {
    let s: ReelState = reelStart(plan);
    expect(s).toEqual({ k: "wait", clip: 0 });
    expect(reelStep(plan, s, at({ complete: false })).cmd).toEqual({ k: "none" });
    let r = reelStep(plan, s, at({}));
    expect(r.cmd).toEqual({ k: "start", t: 78 * H });
    s = r.state;
    r = reelStep(plan, s, at({ playhead: 79 * H, playing: true }));
    expect(r.cmd.k).toBe("none");
    r = reelStep(plan, s, at({ now: 1_000, playhead: 80.5 * H, playing: true }));
    expect(r.cmd).toEqual({ k: "pause" });
    s = r.state;
    expect(s).toEqual({ k: "hold", clip: 0, until: 1_000 + plan.holdMs });
    expect(reelStep(plan, s, at({ now: 5_000 })).state).toBe(s);
    expect(reelStep(plan, s, at({ now: 1_000 + plan.holdMs })).state).toEqual({
      k: "wait",
      clip: 1,
    });
  });

  test("a viewer's pause holds the clip; a seek elsewhere ends the reel", () => {
    const s: ReelState = { k: "play", clip: 1 };
    expect(reelStep(plan, s, at({ playhead: 83 * H, playing: false })).state).toBe(s);
    expect(reelStep(plan, s, at({ playhead: 10 * H })).cmd).toEqual({ k: "stop" });
  });

  test("the last clip's hold ends the reel; skipping past the end too", () => {
    const last = plan.clips.length - 1;
    const r = reelStep(plan, { k: "hold", clip: last, until: 0 }, at({ now: 1 }));
    expect(r).toEqual({ state: { k: "done" }, cmd: { k: "stop" } });
    expect(reelGoto(plan, last + 1)).toEqual({ k: "done" });
    expect(reelGoto(plan, -1)).toEqual({ k: "wait", clip: 0 });
    expect(reelStart(planReel([], 0))).toEqual({ k: "done" });
  });

  test("the caption: the moment just passed, else the one coming", () => {
    const clip = plan.clips[1];
    if (clip === undefined) throw new Error("no clip");
    expect(captionAt(clip, 83 * H)?.moment).toBe(WAR[1]);
    expect(captionAt(clip, 83 * H)?.past).toBe(false);
    expect(captionAt(clip, 84 * H)?.moment).toBe(WAR[2]);
    expect(captionAt(clip, 84 * H)?.past).toBe(true);
    expect(BEFORE_S).toBe(2 * H);
  });
});
