import { describe, expect, test } from "bun:test";
import { DEFAULT_SPEED, SPEEDS } from "../lib/time.ts";
import { frame, scoreStep } from "../testkit.test.ts";
import { Playback } from "./playback.ts";

const score = (pb: Playback): number | undefined => pb.frame?.players.p1?.score;

/** A finished match: base at 0, a step every 100 s up to t = 10,000 (score = step number). */
function replay(): Playback {
  const pb = new Playback({ realtime: false, running: false });
  pb.addFrame(frame(0, 0));
  const steps = Array.from({ length: 100 }, (_, i) => scoreStep(i + 1, (i + 1) * 100, i + 1));
  pb.addSteps(0, 100, steps);
  pb.setEnd(10_000);
  return pb;
}

describe("replay", () => {
  test("the playhead advances by wall time × speed; the frame applies the steps passed", () => {
    const pb = replay();
    pb.seek(0);
    expect(score(pb)).toBe(0);
    pb.setSpeed(300);
    pb.play(1_000);
    expect(pb.tick(2_000)).toBe(true);
    expect(pb.playhead).toBe(300);
    expect(score(pb)).toBe(3);
    pb.tick(2_500);
    expect(pb.playhead).toBe(450);
    expect(score(pb)).toBe(4);
  });

  test("speeds: 5 min/s to 6 h/s, clamped, stepped", () => {
    const pb = replay();
    expect(pb.speed).toBe(DEFAULT_SPEED);
    pb.setSpeed(1);
    expect(pb.speed).toBe(SPEEDS[0]);
    pb.setSpeed(1e9);
    expect(pb.speed).toBe(SPEEDS[4]);
    pb.stepSpeed(-1);
    expect(pb.speed).toBe(10_800);
    pb.setSpeed(300);
    pb.stepSpeed(-1);
    expect(pb.speed).toBe(300);
    pb.stepSpeed(1);
    expect(pb.speed).toBe(900);
  });

  test("a long frame gap does not jump: at most 1 s of wall time per tick", () => {
    const pb = replay();
    pb.seek(0);
    pb.setSpeed(300);
    pb.play(0);
    pb.tick(60_000);
    expect(pb.playhead).toBe(300);
  });

  test("seeking by time and by cursor; the end stops a finished match; play at the end restarts", () => {
    const pb = replay();
    pb.seek(4_250);
    expect(score(pb)).toBe(42);
    expect(pb.seekSeq(10)).toBe(true);
    expect([pb.playhead, score(pb)]).toEqual([1_000, 10]);
    expect(pb.seekSeq(500)).toBe(false);
    pb.seek(9_950);
    pb.setSpeed(3_600);
    pb.play(0);
    pb.tick(500);
    expect([pb.playhead, pb.playing, score(pb)]).toEqual([10_000, false, 100]);
    pb.play(600);
    expect([pb.playhead, pb.playing, score(pb)]).toEqual([0, true, 0]);
  });

  test("a replay opened at the end stays put while the history loads behind it", () => {
    const pb = new Playback({ realtime: false, running: false });
    const latest = frame(100, 10_000, {});
    const end = {
      ...latest,
      players: { ...latest.players, p1: { ...latest.players.p1!, score: 100 } },
    };
    pb.addFrame(end);
    pb.setEnd(10_000);
    expect([pb.playhead, score(pb)]).toEqual([10_000, 100]);
    pb.addFrame(frame(0, 0));
    pb.addSteps(
      0,
      50,
      Array.from({ length: 50 }, (_, i) => scoreStep(i + 1, (i + 1) * 100, i + 1)),
    );
    expect([pb.playhead, score(pb), pb.known]).toEqual([10_000, 100, true]);
    pb.seek(7_000);
    expect(pb.known).toBe(false);
    pb.addSteps(
      50,
      100,
      Array.from({ length: 50 }, (_, i) => scoreStep(i + 51, (i + 51) * 100, i + 51)),
    );
    expect([pb.known, score(pb)]).toEqual([true, 70]);
    expect(pb.timeline.segmentCount).toBe(1);
  });
});

describe("live", () => {
  test("lockstep: the playhead is the last step's time", () => {
    const pb = new Playback({ realtime: false, running: true });
    pb.addFrame(frame(10, 500));
    pb.goLive(0);
    expect([pb.mode, pb.playhead]).toEqual(["live", 500]);
    pb.addSteps(10, 12, [scoreStep(12, 700, 7)]);
    expect([pb.playhead, score(pb)]).toEqual([700, 7]);
    pb.tick(10_000);
    expect(pb.playhead).toBe(700);
  });

  test("real time: the clock is anchored on receipt and capped", () => {
    const pb = new Playback({ realtime: true, running: true });
    pb.addFrame(frame(10, 1_000));
    pb.goLive(0);
    pb.setClock({ t: 1_000, speed: [3, 1], cap: 1_100, at: 5_000 });
    pb.tick(5_000);
    expect(pb.playhead).toBe(1_000);
    pb.tick(25_000);
    expect(pb.playhead).toBe(1_060);
    expect(pb.view(25_000).waiting).toBe(false);
    pb.tick(65_000);
    expect(pb.playhead).toBe(1_100);
    expect(pb.view(65_000).waiting).toBe(true);
    // Steps beyond the anchor move the head, and the clock is not waiting any more: they are shown.
    pb.addSteps(10, 11, [scoreStep(11, 1_500, 3)]);
    pb.tick(66_000);
    expect([pb.playhead, score(pb)]).toEqual([1_500, 3]);
    expect(pb.view(66_000).waiting).toBe(false);
  });

  test("real time: a step exactly at the cap ends the wait; one before it does not", () => {
    const pb = new Playback({ realtime: true, running: true });
    pb.addFrame(frame(10, 1_000));
    pb.goLive(0);
    pb.setClock({ t: 1_000, speed: [600, 1], cap: 1_100, at: 0 });
    pb.addSteps(10, 11, [scoreStep(11, 1_099, 1)]);
    expect(pb.view(10_000).waiting).toBe(true);
    pb.addSteps(11, 12, [scoreStep(12, 1_100, 2)]);
    expect(pb.view(10_000).waiting).toBe(false);
  });

  test("pause switches to replay over the steps held; a replay reaching the head goes live", () => {
    const pb = new Playback({ realtime: false, running: true });
    pb.addFrame(frame(0, 0));
    pb.addSteps(0, 5, [scoreStep(2, 200, 1), scoreStep(5, 500, 2)]);
    pb.goLive(0);
    pb.pause();
    expect([pb.mode, pb.playing]).toEqual(["replay", false]);
    pb.seek(100);
    expect(score(pb)).toBe(0);
    pb.setSpeed(300);
    pb.play(0);
    pb.tick(1_000);
    expect([pb.mode, pb.playhead, score(pb)]).toEqual(["replay", 400, 1]);
    pb.tick(2_000);
    expect([pb.mode, pb.playhead, score(pb)]).toEqual(["live", 500, 2]);
    // Seeking while live leaves live.
    pb.seek(250);
    expect([pb.mode, score(pb)]).toEqual(["replay", 1]);
    pb.goLive(0);
    expect(pb.mode).toBe("live");
    pb.setRunning(false);
    expect([pb.mode, pb.playing]).toEqual(["replay", false]);
  });

  test("a live viewer stays at the head when the match ends, also for the lines after the status", () => {
    const pb = new Playback({ realtime: true, running: true });
    pb.addFrame(frame(10, 1_000));
    pb.goLive(0);
    pb.setClock({ t: 1_000, speed: [600, 1], cap: 1_100, at: 0 });
    pb.tick(100);
    expect(pb.playhead).toBe(1_060);
    pb.setRunning(false);
    expect([pb.mode, pb.playing]).toEqual(["replay", false]);
    pb.addSteps(10, 12, [scoreStep(12, 1_200, 9, true)]);
    expect([pb.playhead, score(pb)]).toEqual([1_200, 9]);
    expect(pb.feed().map((e) => e.seq)).toEqual([12]);
    // Once the viewer seeks, the playhead no longer follows.
    pb.seek(1_000);
    pb.addSteps(12, 13, [scoreStep(13, 1_300, 10)]);
    expect(pb.playhead).toBe(1_000);
  });

  test("feed entries follow the frame shown", () => {
    const pb = new Playback({ realtime: false, running: false });
    pb.addFrame(frame(0, 0));
    pb.addSteps(0, 3, [
      scoreStep(1, 10, 1, true),
      scoreStep(2, 20, 2, true),
      scoreStep(3, 30, 3, true),
    ]);
    pb.seek(20);
    expect(pb.feed().map((e) => e.seq)).toEqual([1, 2]);
  });
});
