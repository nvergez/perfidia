import { canonicalJson, CanonicalJsonError, fnv1a64 } from "@perfidia/engine/core";
import type { AnyRuleset } from "@perfidia/engine/contracts";
import {
  GameStateSchema,
  MatchSetupSchema,
  SNAPSHOT_FORMAT,
  type GameState,
  type Hash64,
  type MatchSetup,
  type Sha256,
  type Snapshot,
} from "@perfidia/protocol";
import { canonicalCopy, jsonCopy } from "./copy.ts";
import { SnapshotMismatch } from "./errors.ts";
import { ENGINE_VERSION } from "./version.ts";

// Snapshots (docs/architecture.md §10.3): `{format, engine, setup, configHash, rulesHash, hour, t,
// afterN, hash, state}`, always a canonical copy, never a reference to the live state (§6.6).

/** FNV-1a 64 of the canonical state (§6.3). */
export function stateHash(state: GameState): Hash64 {
  return fnv1a64(canonicalJson(state));
}

/** The snapshot envelope of `state` (a canonical copy of everything). */
export function makeSnapshot(p: {
  setup: MatchSetup;
  configHash: Sha256;
  rulesHash: Sha256;
  hour: number;
  afterN: number;
  state: GameState;
}): Snapshot {
  const { text, copy } = canonicalCopy(p.state);
  return {
    format: SNAPSHOT_FORMAT,
    engine: ENGINE_VERSION,
    setup: jsonCopy(p.setup),
    configHash: p.configHash,
    rulesHash: p.rulesHash,
    hour: p.hour,
    t: p.state.now,
    afterN: p.afterN,
    hash: fnv1a64(text),
    state: copy,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstIssue(issues: readonly { path: readonly PropertyKey[]; message: string }[]): string {
  const issue = issues[0];
  if (issue === undefined) return "invalid";
  const path = issue.path.map((p) => String(p)).join(".");
  return path === "" ? issue.message : `${path}: ${issue.message}`;
}

/** The envelope checks that need no ruleset: format, setup and the plain fields. */
export function checkEnvelope(snap: Snapshot): MatchSetup {
  const raw: unknown = snap;
  if (!isRecord(raw)) throw new SnapshotMismatch("format", "a snapshot is a JSON object");
  if (raw["format"] !== SNAPSHOT_FORMAT) {
    throw new SnapshotMismatch(
      "format",
      `expected ${SNAPSHOT_FORMAT}, got ${JSON.stringify(raw["format"])}`,
    );
  }
  const setup = MatchSetupSchema.safeParse(raw["setup"]);
  if (!setup.success) throw new SnapshotMismatch("setup", firstIssue(setup.error.issues));
  for (const field of ["hour", "t", "afterN"] as const) {
    const v = raw[field];
    if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) {
      throw new SnapshotMismatch(
        field,
        `expected a non-negative integer, got ${JSON.stringify(v)}`,
      );
    }
  }
  return jsonCopy(setup.data);
}

/** The ruleset ref of the setup, the state and the ruleset must be equal. */
export function checkRef(snap: Snapshot, setup: MatchSetup, ruleset: AnyRuleset): void {
  const stateRef: unknown = isRecord(snap.state) ? snap.state["ruleset"] : undefined;
  if (setup.ruleset !== ruleset.ref || stateRef !== ruleset.ref) {
    throw new SnapshotMismatch(
      "ruleset",
      `setup says ${setup.ruleset}, the state says ${JSON.stringify(stateRef)}, the ruleset is ${ruleset.ref}`,
    );
  }
}

/** A canonical copy of the snapshot state, parsed with the `GameState` schema. */
export function copyState(snap: Snapshot): GameState {
  let copy: unknown;
  try {
    copy = jsonCopy<unknown>(snap.state);
  } catch (error) {
    if (error instanceof CanonicalJsonError) throw new SnapshotMismatch("state", error.message);
    throw error;
  }
  const parsed = GameStateSchema.safeParse(copy);
  if (!parsed.success) throw new SnapshotMismatch("state", firstIssue(parsed.error.issues));
  return parsed.data;
}
