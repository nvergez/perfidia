// Projection freshness: the fold diffs entities only on lines that can change them, so after every
// line its frame must equal a projection made from scratch of a parallel replay (engine state and
// gateway fold). This catches a fold that skips a line it should project: a silent world timer
// (perfidia-1@1.1.0's `domination_open` flips `ext.domination.open` with no event), or seat fields
// (`next`, the effective next wake) that an `ev` line moves for every seat.
// The 4-day golden's test runs in the slow suite (PERFIDIA_SLOW=1, docs/architecture.md §13.8:
// `bun run test:slow`, run by `bun run test:exit`).

import { describe, expect, test } from "bun:test";
import { createReplay } from "@perfidia/engine";
import { canonicalJson } from "@perfidia/engine/core";
import type { ReadCtx } from "@perfidia/engine/contracts";
import { visibilityOf } from "@perfidia/gateway/present";
import { createGatewayFold, type GatewayFold } from "@perfidia/gateway/runtime";
import type { Frame, HeaderLine, LogLine, PlayerId, QueueEnt } from "@perfidia/protocol";
import { golden } from "../testkit.test.ts";
import { createSpectatorFold } from "./fold.ts";
import {
  allianceEnt,
  armies,
  cityEnt,
  movementEnt,
  pactEnts,
  playerEnt,
  popUsedByCity,
  proposalEnts,
  queueEnts,
  standingsOf,
} from "./project.ts";

const SLOW = process.env["PERFIDIA_SLOW"] === "1";
/** A test of the slow suite: skipped unless PERFIDIA_SLOW=1. */
const xtest = test.skipIf(!SLOW);

const headerOf = (lines: readonly LogLine[]): HeaderLine => {
  const h = lines[0];
  if (h?.k !== "header") throw new Error("no header");
  return h;
};

/** Every engine-derived collection of a frame, projected from scratch (`turnedAt` aside). */
function engineView(r: ReadCtx): Record<string, string> {
  const vis = visibilityOf(r);
  const pop = popUsedByCity(r);
  const cities: Record<string, unknown> = {};
  const queues = new Map<string, QueueEnt>();
  for (const c of Object.values(r.state.cities)) {
    cities[c.id] = cityEnt(r, vis, c, pop.get(c.id) ?? 0, "p1");
    queueEnts(r, c, queues);
  }
  const movements: Record<string, unknown> = {};
  for (const m of Object.values(r.state.movements)) movements[m.id] = movementEnt(m, null);
  const standings = standingsOf(r);
  const armyOf = armies(r);
  const players: Record<string, unknown> = {};
  for (const p of Object.values(r.state.players)) {
    const standing = standings.find((s) => s.player === p.id);
    players[p.id] = playerEnt(r, vis, p, standing, armyOf.get(p.id));
  }
  const alliances: Record<string, unknown> = {};
  for (const a of Object.values(r.state.alliances)) alliances[a.id] = allianceEnt(a);
  return {
    cities: canonicalJson(cities),
    queues: canonicalJson(Object.fromEntries(queues)),
    movements: canonicalJson(movements),
    players: canonicalJson(players),
    alliances: canonicalJson(alliances),
    pacts: canonicalJson(pactEnts(r)),
    proposals: canonicalJson(proposalEnts(r)),
    ext: canonicalJson(vis.publicMatch()),
  };
}

function frameView(f: Frame): Record<string, string> {
  const movements: Record<string, unknown> = {};
  for (const [id, m] of Object.entries(f.movements)) movements[id] = { ...m, turnedAt: null };
  return {
    cities: canonicalJson(f.cities),
    queues: canonicalJson(f.queues),
    movements: canonicalJson(movements),
    players: canonicalJson(f.players),
    alliances: canonicalJson(f.alliances),
    pacts: canonicalJson(f.pacts),
    proposals: canonicalJson(f.proposals),
    ext: canonicalJson(f.ext),
  };
}

/** The seat fields that come from the gateway fold, from scratch. */
function seatView(gw: GatewayFold, seats: readonly PlayerId[], ended: boolean): string {
  const out: Record<string, unknown> = {};
  for (const seat of seats) {
    const s = Object.hasOwn(gw.gw.seats, seat) ? gw.gw.seats[seat] : undefined;
    if (s === undefined) continue;
    const peek = ended || !s.alive ? null : (gw.wake?.peek(seat) ?? null);
    out[seat] = {
      inTurn: s.wake.inTurn,
      turn: s.turns,
      notesChars: s.notes.length,
      next: peek === null ? null : { at: peek.at, kind: peek.kind },
    };
  }
  return canonicalJson(out);
}

function frameSeats(f: Frame): string {
  const out: Record<string, unknown> = {};
  for (const [seat, s] of Object.entries(f.seats)) {
    out[seat] = { inTurn: s.inTurn, turn: s.turn, notesChars: s.notesChars, next: s.next };
  }
  return canonicalJson(out);
}

interface Mismatch {
  readonly what: string;
  readonly line: number;
}

/** Folds `lines`, comparing after every line; `full`: every collection, else `ext` and seats. */
function check(lines: readonly LogLine[], full: boolean): { mismatches: Mismatch[]; at: number[] } {
  const header = headerOf(lines);
  const fold = createSpectatorFold(header, { match: "fresh" });
  const replay = createReplay(header, { invariants: "off" });
  const gw = createGatewayFold();
  gw.line(header, replay.read(), undefined);
  const seats = header.setup.seats.map((x) => x.id);
  const mismatches: Mismatch[] = [];
  const openAt: number[] = [];
  let open: unknown = null;
  for (const [i, line] of lines.slice(1).entries()) {
    fold.push(line);
    const out = replay.push(line);
    if (!out.ok) throw new Error(`the replay diverged at line ${i + 1}`);
    const r = replay.read();
    gw.line(line, r, out.applied);
    const frame = fold.frame();
    if (full) {
      const want = engineView(r);
      const got = frameView(frame);
      for (const k of Object.keys(want)) {
        if (want[k] !== got[k]) mismatches.push({ what: k, line: i + 1 });
      }
    } else {
      const ext = canonicalJson(visibilityOf(r).publicMatch());
      if (ext !== canonicalJson(frame.ext)) mismatches.push({ what: "ext", line: i + 1 });
    }
    if (seatView(gw, seats, fold.status === "ended") !== frameSeats(frame)) {
      mismatches.push({ what: "seats", line: i + 1 });
    }
    const domination = frame.ext["domination"];
    const now =
      domination !== null && typeof domination === "object" && !Array.isArray(domination)
        ? (domination["open"] ?? null)
        : null;
    if (now !== open) {
      openAt.push(i + 1);
      open = now;
    }
  }
  return { mismatches, at: openAt };
}

describe("the fold's frame equals a fresh projection after every line", () => {
  test("rt-virtual-6p-1d: every collection and the seats", () => {
    const lines = golden("perfidia-1@1.1.0/rt-virtual-6p-1d.jsonl");
    const { mismatches } = check(lines, true);
    expect(mismatches.slice(0, 5)).toEqual([]);
  });

  xtest("lockstep-6p-4d: ext (the silent domination_open timer) and the seats", () => {
    const lines = golden("perfidia-1@1.1.0/lockstep-6p-4d.jsonl");
    const { mismatches, at } = check(lines, false);
    expect(mismatches.slice(0, 5)).toEqual([]);
    // `ext.domination.open` flips once, at the first line at or after the opening time, which
    // carries no domination event.
    const time = headerOf(lines).config["time"];
    const opening =
      time !== null && typeof time === "object" && !Array.isArray(time)
        ? Number(time["dominationStart"])
        : Number.NaN;
    expect(Number.isInteger(opening)).toBe(true);
    const flips = at.slice(1);
    expect(flips).toHaveLength(1);
    const flip = lines[flips[0] ?? 0];
    if (flip === undefined || flip.k === "header") throw new Error("no flip line");
    expect(flip.t).toBeGreaterThanOrEqual(opening);
    const before = lines[(flips[0] ?? 0) - 1];
    expect(before !== undefined && before.k !== "header" && before.t < opening).toBe(true);
  });
});
