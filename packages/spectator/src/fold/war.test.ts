// The spectator fold on the 6-day war golden (perfidia-1@1.1.0, 16,253 lines, seed 14): the feed
// tells its story (10 messages, 7 proposals, 42 battles, 3 alliances, one betrayal with its context,
// the attack on an ally launched before it, sieges, conquests, a1's domination countdown and win),
// the final frame holds 31 islands and 42 cities and its standings equal the end line, every
// keyframe equals the previous one with its steps applied, the steps are deterministic and the same
// however the fold is read along the way, the frames hold materialised values only, and nothing
// served carries a secret of the header.

import { beforeAll, describe, expect, test } from "bun:test";
import { createReplay } from "@perfidia/engine";
import { canonicalJson, fmtTime, idKeyFromSeed } from "@perfidia/engine/core";
import type { ReadCtx } from "@perfidia/engine/contracts";
import { visibilityOf } from "@perfidia/gateway/present";
import {
  FeedItemSchema,
  FrameSchema,
  MomentSchema,
  StepSchema,
  type FeedItem,
  type FeedItemOf,
  type HeaderLine,
  type LogLine,
} from "@perfidia/protocol";
import { applySteps, notebookTexts, seatTally, standingsOf } from "../reduce/index.ts";
import { WAR_GOLDEN, expectNoSecrets, golden } from "../testkit.test.ts";
import { createSpectatorFold, foldLog, type SpectatorFold } from "./fold.ts";
import {
  armies,
  cityEnt,
  movementEnt,
  playerEnt,
  popUsedByCity,
  standingsOf as ruleStandings,
} from "./project.ts";

let lines: LogLine[] = [];
let fold: SpectatorFold;
let items: FeedItem[] = [];
let foldMs = 0;

const itemsOf = <K extends FeedItem["k"]>(k: K): FeedItemOf<K>[] =>
  items.filter((i): i is FeedItemOf<K> => i.k === k);

beforeAll(() => {
  lines = golden(WAR_GOLDEN);
  const t0 = performance.now();
  fold = foldLog(lines, { match: "war-golden" });
  foldMs = performance.now() - t0;
  items = fold.steps.flatMap((s) => s.items ?? []);
}, 60_000);

/** Moments of a kind. */
const kinds = (k: string): number => fold.moments.filter((m) => m.k === k).length;

/** The same read context, `dt` game-seconds later (nothing has happened in between). */
const later = (r: ReadCtx, dt: number): ReadCtx => ({
  state: r.state,
  now: r.now + dt,
  rules: r.rules,
  config: r.config,
  ruleset: r.ruleset,
  ext: () => r.ext(),
});

/** The entities a frame would hold for a read context. */
const project = (r: ReadCtx): string => {
  const vis = visibilityOf(r);
  const pop = popUsedByCity(r);
  const standings = ruleStandings(r);
  const army = armies(r);
  return JSON.stringify({
    cities: Object.values(r.state.cities).map((c) => cityEnt(r, vis, c, pop.get(c.id) ?? 0, "p1")),
    movements: Object.values(r.state.movements).map((m) => movementEnt(m, null)),
    players: Object.values(r.state.players).map((p) =>
      playerEnt(
        r,
        vis,
        p,
        standings.find((s) => s.player === p.id),
        army.get(p.id),
      ),
    ),
  });
};

function headerOf(log: readonly LogLine[]): HeaderLine {
  const h = log[0];
  if (h?.k !== "header") throw new Error("no header");
  return h;
}

describe("the war golden through the spectator fold", () => {
  test("ends verified with the end line's result and standings, 31 islands and 42 cities", () => {
    expect(fold.status).toBe("ended");
    expect(fold.verified()).toEqual({ ok: true, divergence: null });
    expect(fold.gatewayDrift()).toBeNull();
    expect(fold.lastSeq).toBe(lines.length - 1);
    const end = lines.at(-1);
    if (end?.k !== "end") throw new Error("no end line");
    const frame = fold.frame();
    expect(frame.result).toEqual({ reason: "domination", winners: ["p1", "p4"] });
    expect(canonicalJson(standingsOf(frame))).toBe(canonicalJson(end.result.standings));
    expect(fold.map().islands).toHaveLength(31);
    expect([fold.map().width, fold.map().height]).toEqual([600, 600]);
    expect(Object.keys(frame.cities)).toHaveLength(42);
    expect(FrameSchema.parse(frame)).toEqual(frame);
    console.log(
      `war golden: ${lines.length} lines folded in ${Math.round(foldMs)} ms; ${fold.steps.length} steps (${JSON.stringify(fold.steps).length} bytes), ${fold.keyframes.length} keyframes, ${fold.moments.length} moments; final frame ${JSON.stringify(frame).length} bytes`,
    );
  });

  test("the feed: 10 messages, 7 proposals, 42 battles, 3 alliances, the betrayal of p3 by p2 at c18", () => {
    const messages = itemsOf("message");
    expect(messages).toHaveLength(10);
    expect(new Set(messages.map((m) => m.message)).size).toBe(10);
    expect(itemsOf("proposal")).toHaveLength(7);
    expect(itemsOf("answer")).toHaveLength(7);
    expect(itemsOf("battle")).toHaveLength(42);
    expect(itemsOf("battle").every((b) => b.reports.length > 0)).toBe(true);
    const formed = itemsOf("diplomacy").filter((d) => d.event === "alliance_formed");
    expect(formed.map((d) => [d.alliance, d.name, fmtTime(d.t), d.players])).toEqual([
      ["a1", "War p1", "D2 00:10", ["p1", "p4"]],
      ["a2", "League p2", "D3 02:14:34", ["p2", "p3"]],
      ["a3", "League p2", "D4 13:10:33", ["p2", "p5"]],
    ]);
    const betrayals = itemsOf("betrayal");
    expect(betrayals.map((b) => [b.by, b.against, b.relation, b.city, fmtTime(b.t)])).toEqual([
      ["p2", "p3", "ally", "c18", "D4 12:50:33"],
    ]);
    const context = betrayals[0]?.context;
    // p2's private messages to p3 before it struck, and its thoughts naming p3.
    expect(context?.messages.map((m) => m.text)).toEqual([
      "WAR#k1 strike c19 vs p4 land D3 14:42:41-15:42:41 (I land 15:12:41)",
      "we remain friends",
    ]);
    for (const m of context?.messages ?? []) {
      const item = messages.find((x) => x.id === m.item);
      expect([item?.from, item?.to]).toEqual(["p2", ["p3"]]);
    }
    expect(context?.thoughts.length).toBe(3);
    expect(context?.thoughts.every((x) => /\bp3\b/.test(x.text))).toBe(true);
    expect(context?.since).toBe(formed[1]?.t ?? -1);
    // The betrayer left a2 by betrayal: a key moment naming both.
    const left = itemsOf("diplomacy").find((d) => d.event === "alliance_left");
    expect([left?.cause, left?.players, left?.importance]).toEqual(["betrayal", ["p2", "p3"], 3]);
  });

  test("the attack on an ally was a moment when it was launched, before it landed", () => {
    const launches = itemsOf("launch").filter((l) => l.againstAlly !== null);
    const onP3 = launches.find((l) => l.target === "p3");
    expect(onP3).toMatchObject({
      owner: "p2",
      to: "c18",
      againstAlly: "ally",
      importance: 3,
      arriveAt: 305433,
    });
    expect(onP3?.t).toBeLessThan(305433);
    expect(onP3?.context?.messages.map((m) => m.text)).toContain("we remain friends");
    const moment = fold.moments.find((m) => m.item === onP3?.id);
    expect(moment?.title).toBe("p2 launched an attack on its ally p3 at c18, landing D4 12:50:33");
    // The only attack on an ally: p2's later attacks at its ally p5's c17 fought p6, the besieger
    // (reliefs), and are told as such.
    expect(launches.map((l) => [l.owner, l.foe, fmtTime(l.t)])).toEqual([
      ["p2", "p3", "D4 08:56:32"],
    ]);
    const reliefs = itemsOf("launch").filter(
      (l) => l.owner === "p2" && l.to === "c17" && l.foe !== l.target,
    );
    expect(
      reliefs.map((l) => [l.target, l.foe, l.importance, l.againstAlly, fmtTime(l.t)]),
    ).toEqual([
      ["p5", "p6", 2, null, "D5 09:17:59"],
      ["p5", "p6", 2, null, "D6 14:05:58"],
      ["p5", "p6", 2, null, "D6 14:05:58"],
    ]);
    const relief = fold.moments.find((m) => m.item === reliefs[0]?.id);
    expect(relief?.title).toBe(
      "p2 launched a relief of c17 (p5), besieged by p6, landing D5 14:58:50",
    );
    expect(relief?.context).toBeUndefined();
    // Every attack told as against an ally fights an ally or pact partner of the attacker at launch
    // (the frame of its step), and every attack's foe is the target's owner or a besieger.
    let frame = fold.keyframes[0]?.frame;
    if (frame === undefined) throw new Error("no keyframe 0");
    let checked = 0;
    for (const step of fold.steps) {
      frame = applySteps(frame, [step]);
      for (const item of step.items ?? []) {
        if (item.k !== "launch" || item.kind !== "attack") continue;
        const city = item.to === null ? undefined : frame.cities[item.to];
        const siege = city?.ext["siege"];
        const besieger =
          siege !== null && typeof siege === "object" && !Array.isArray(siege)
            ? (siege["by"] ?? null)
            : null;
        expect([item.id, item.foe === item.target || item.foe === besieger]).toEqual([
          item.id,
          true,
        ]);
        if (item.againstAlly === null) continue;
        const rel = frame.players[item.owner]?.relations.find((x) => x.player === item.foe);
        expect([item.id, rel?.kind]).toEqual([item.id, item.againstAlly]);
        checked += 1;
      }
    }
    expect(checked).toBe(1);
  });

  test("sieges, conquests, a1's countdown and its win; moment kinds match the events", () => {
    const events = lines.flatMap((l) => (l.k === "ev" ? [l.e.type] : []));
    const count = (type: string): number => events.filter((t) => t === type).length;
    const sieges = itemsOf("siege");
    expect(sieges.filter((s) => s.event === "started")).toHaveLength(count("siege_started"));
    expect(sieges.filter((s) => s.event === "broken")).toHaveLength(count("siege_broken"));
    expect(itemsOf("conquest")).toHaveLength(count("city_conquered"));
    expect(itemsOf("founding")).toHaveLength(count("city_founded"));
    expect(itemsOf("spy")).toHaveLength(
      count("spy_report") + count("spy_failed") + count("spy_detected"),
    );
    expect(
      itemsOf("countdown").map((c) => [
        c.key,
        c.members,
        c.cities,
        c.taken,
        fmtTime(c.t),
        c.endsAt === null ? "" : fmtTime(c.endsAt),
      ]),
    ).toEqual([["a1", ["p1", "p4"], 16, 2, "D5 18:33:27", "D6 18:33:27"]]);
    expect(itemsOf("end").map((e) => [e.reason, e.winners, fmtTime(e.t)])).toEqual([
      ["domination", ["p1", "p4"], "D6 18:33:27"],
    ]);
    expect(kinds("betrayal")).toBe(count("betrayal"));
    expect(kinds("conquest")).toBe(count("city_conquered"));
    expect(kinds("siege")).toBe(count("siege_started") + count("siege_broken"));
    expect(kinds("countdown")).toBe(count("domination_started") + count("domination_cancelled"));
    expect(kinds("end")).toBe(1);
    // A battle is a moment when a siege started or broke there, the city fell, or it was the first.
    // Waves landing in the same second at one city: only the battle that caused it is flagged.
    const battles = itemsOf("battle");
    expect(battles.filter((b) => b.siege === "started")).toHaveLength(count("siege_started"));
    expect(battles.filter((b) => b.siege === "broken")).toHaveLength(count("siege_broken"));
    expect(battles[0]?.importance).toBe(2);
    expect(kinds("battle")).toBe(
      battles.filter((b, i) => i === 0 || b.siege !== null || b.fell).length,
    );
    for (const m of fold.moments) expect(MomentSchema.parse(m)).toEqual(m);
    // Every turn has its item; LLM-free match: all bot turns, importance 0.
    expect(itemsOf("turn")).toHaveLength(lines.filter((l) => l.k === "turn").length);
    expect(itemsOf("turn").every((x) => !x.llm && x.importance === 0)).toBe(true);
  });

  test("the dossier's record: p2's betrayal of p3 once on each side, the log's messages and turns", () => {
    const seats = headerOf(lines).setup.seats.map((s) => s.id);
    const sent = new Map<string, number>();
    const received = new Map<string, number>();
    for (const l of lines) {
      if (l.k !== "ev" || l.e.type !== "message") continue;
      const from = l.e.data["from"];
      const to = l.e.data["to"];
      if (typeof from !== "string") throw new Error("a message event without a sender");
      sent.set(from, (sent.get(from) ?? 0) + 1);
      const recipients = to === "all" ? seats : Array.isArray(to) ? to : [];
      for (const p of recipients)
        if (typeof p === "string" && p !== from) received.set(p, (received.get(p) ?? 0) + 1);
    }
    const tallies = seats.map((s) => [s, seatTally(items, s)] as const);
    expect(tallies.map(([s, x]) => [s, x.betrayalsCommitted, x.betrayalsSuffered])).toEqual([
      ["p1", 0, 0],
      ["p2", 1, 0],
      ["p3", 0, 1],
      ["p4", 0, 0],
      ["p5", 0, 0],
      ["p6", 0, 0],
    ]);
    for (const [s, x] of tallies) {
      const turns = lines.filter((l) => l.k === "turn" && l.seat === s).length;
      expect([s, x.turns, x.messagesSent, x.messagesReceived]).toEqual([
        s,
        turns,
        sent.get(s) ?? 0,
        received.get(s) ?? 0,
      ]);
      // The server's counts (the end of the fold) agree with the record over every item.
      expect(fold.counts(s)).toEqual({
        turns,
        messagesSent: x.messagesSent,
        messagesReceived: x.messagesReceived,
      });
    }
    expect(tallies.reduce((n, [, x]) => n + x.messagesSent, 0)).toBe(10);
  });

  test("the dossier's series: a point per checkpoint as the frames have it; every notebook version", () => {
    const seats = headerOf(lines).setup.seats.map((s) => s.id);
    const ckpts = lines.flatMap((l) => (l.k === "ckpt" || l.k === "end" ? [l] : []));
    expect(ckpts).toHaveLength(139);
    for (const s of seats) {
      const points = fold.hourly(s);
      expect(points.map((p) => p.t)).toEqual(ckpts.map((c) => c.t));
      // The end line's point is the final frame's player.
      const last = fold.frame().players[s];
      expect(points.at(-1)).toEqual({
        t: 498_807,
        score: last?.score ?? -1,
        cities: last?.cities ?? -1,
      });
      // Six-hourly keyframes sit on checkpoint lines: the point is the frame's player there.
      for (const kf of fold.keyframes) {
        const line = lines[kf.seq];
        if (line?.k !== "ckpt") continue;
        const p = kf.frame.players[s];
        expect(points.find((x) => x.t === line.t)).toEqual({
          t: line.t,
          score: p?.score ?? -1,
          cities: p?.cities ?? -1,
        });
      }
    }
    // The notebooks: every change a note line made (bots rewrite their JSON memory), all kept, the
    // last one the notebook now.
    const now = new Map<string, string>();
    const changes = new Map<string, number>();
    for (const l of lines) {
      if (l.k !== "note") continue;
      const prev = now.get(l.seat) ?? "";
      const next =
        l.mode === "replace"
          ? l.text
          : l.text === ""
            ? prev
            : prev === ""
              ? l.text
              : `${prev}\n${l.text}`;
      if (next !== prev) changes.set(l.seat, (changes.get(l.seat) ?? 0) + 1);
      now.set(l.seat, next);
    }
    const totals = seats.map((s) => [s, fold.notebook(s).total]);
    expect(totals).toEqual([
      ["p1", 80],
      ["p2", 64],
      ["p3", 33],
      ["p4", 87],
      ["p5", 39],
      ["p6", 58],
    ]);
    for (const s of seats) {
      const h = fold.notebook(s);
      expect([s, h.total]).toEqual([s, changes.get(s) ?? 0]);
      expect(h.versions).toHaveLength(h.total);
      const texts = notebookTexts(h);
      expect(texts?.at(-1)).toBe(fold.notes(s) ?? "");
      expect(texts?.at(-1)).toBe(now.get(s) ?? "");
      expect(h.versions.every((v, i) => i === 0 || v.t >= (h.versions[i - 1]?.t ?? 0))).toBe(true);
    }
    const kept = seats.map((s) => JSON.stringify(fold.notebook(s)).length);
    const hourly = seats.map((s) => JSON.stringify(fold.hourly(s)).length);
    console.log(
      `war golden dossier series: hourly ${hourly.join("/")} bytes, notebook history ${kept.join("/")} bytes (p1–p6, JSON)`,
    );
  });

  test("every step and item parses; item ids are their cursor and index", () => {
    for (const step of fold.steps) {
      expect(StepSchema.parse(step)).toEqual(step);
      for (const [i, item] of (step.items ?? []).entries()) {
        expect(item.id).toBe(`${step.seq}:${i}`);
        expect(FeedItemSchema.safeParse(item).success).toBe(true);
      }
    }
    // A step per ckpt line: the game clock ticks.
    const ckpts = lines.flatMap((l, i) => (l.k === "ckpt" ? [i] : []));
    const seqs = new Set(fold.steps.map((s) => s.seq));
    expect(ckpts.every((i) => seqs.has(i))).toBe(true);
  });

  test("every keyframe is the previous one with its steps applied; the last frame too", () => {
    expect(fold.keyframes[0]?.seq).toBe(0);
    for (const [i, kf] of fold.keyframes.entries()) {
      if (i === 0) continue;
      const prev = fold.keyframes[i - 1];
      if (prev === undefined) throw new Error("no keyframe");
      const steps = fold.steps.filter((s) => s.seq > prev.seq && s.seq <= kf.seq);
      expect(canonicalJson(applySteps(prev.frame, steps))).toBe(canonicalJson(kf.frame));
    }
    const first = fold.keyframes[0]?.frame;
    if (first === undefined) throw new Error("no keyframe 0");
    expect(canonicalJson(applySteps(first, fold.steps))).toBe(canonicalJson(fold.frame()));
    // Keyframes every 6 game hours (ckpt hours divisible by 6) or 1000 steps.
    for (const kf of fold.keyframes.slice(1)) {
      const line = lines[kf.seq];
      const sixHourly = line?.k === "ckpt" && line.hour % 6 === 0;
      expect(sixHourly || fold.steps.findIndex((s) => s.seq === kf.seq) >= 0).toBe(true);
    }
  });

  test("the steps do not depend on how the fold is read along the way, and are deterministic", () => {
    const header = headerOf(lines);
    const again = createSpectatorFold(header, { match: "war-golden" });
    const frames: string[] = [];
    for (const [i, line] of lines.slice(1).entries()) {
      again.push(line);
      if (i % 997 === 0) frames.push(canonicalJson(again.frame()));
      if (i % 1499 === 0) again.verified();
    }
    expect(JSON.stringify(again.steps)).toBe(JSON.stringify(fold.steps));
    expect(JSON.stringify(again.moments)).toBe(JSON.stringify(fold.moments));
    expect(again.keyframes.map((k) => k.seq)).toEqual(fold.keyframes.map((k) => k.seq));
    expect(canonicalJson(again.frame())).toBe(canonicalJson(fold.frame()));
    for (const s of header.setup.seats) {
      expect(JSON.stringify(again.hourly(s.id))).toBe(JSON.stringify(fold.hourly(s.id)));
      expect(JSON.stringify(again.notebook(s.id))).toBe(JSON.stringify(fold.notebook(s.id)));
    }
    expect(frames.length).toBeGreaterThan(10);
  }, 60_000);

  test("frames hold materialised values only: projecting the same state later changes nothing", () => {
    const header = headerOf(lines);
    const replay = createReplay(header, { invariants: "off" });
    let checked = 0;
    for (const [i, line] of lines.slice(1).entries()) {
      replay.push(line);
      if (i % 1201 !== 600 || line.k === "end") continue;
      const r = replay.read();
      expect(project(later(r, 5400))).toBe(project(r));
      checked += 1;
    }
    expect(checked).toBeGreaterThan(10);
  });

  test("nothing served carries the header's idKey or seed, or a wall key but wallStart", () => {
    const header = headerOf(lines);
    expect(header.setup.idKey).toBe(idKeyFromSeed(header.setup.seed));
    const served = {
      steps: fold.steps,
      keyframes: fold.keyframes,
      moments: fold.moments,
      frame: fold.frame(),
      map: fold.map(),
      verified: fold.verified(),
      reports: itemsOf("battle").flatMap((b) => b.reports.map((r) => fold.report(r))),
      notes: header.setup.seats.map((s) => fold.notes(s.id)),
      hourly: header.setup.seats.map((s) => fold.hourly(s.id)),
      notebooks: header.setup.seats.map((s) => fold.notebook(s.id)),
    };
    expectNoSecrets(served, { idKey: header.setup.idKey, seed: header.setup.seed });
  });
});
