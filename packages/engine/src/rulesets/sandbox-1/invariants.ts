import type { Invariant, ReadCtx } from "@perfidia/engine/contracts";
import { compareIds, z } from "@perfidia/protocol";
import { HILL_OPEN } from "./compile.ts";
import { SandboxExtSchema } from "./ext.ts";

// The invariants of sandbox-1 (docs/architecture.md §13.3), covering its own event kind: the
// `hill_open` timer matches `ext.hillOpen`, and the shapes sandbox-1 never creates (no neutral
// city, no `hold` group: there are no sieges) never appear.

/** The one config field the invariants read (`ReadCtx.config` is untyped here). */
const HillTimeSchema = z.looseObject({ time: z.looseObject({ hillOpen: z.int() }) });

/**
 * While the match runs and the hill is closed, exactly one `hill_open` event is queued, at
 * `time.hillOpen` with ref `""`; once the hill is open, none is.
 */
const hillTimer: Invariant = {
  name: "sandbox.hill-timer",
  level: "step",
  check(r: ReadCtx): readonly string[] {
    const ext = SandboxExtSchema.safeParse(r.state.ext);
    if (!ext.success) return ["state.ext is not {hillOpen: boolean}"];
    const timers = r.state.queue.filter((e) => e.kind === HILL_OPEN);
    if (ext.data.hillOpen) {
      return timers.length === 0 ? [] : [`the hill is open but ${HILL_OPEN} is still queued`];
    }
    const out: string[] = [];
    if (r.state.status === "running" && timers.length !== 1) {
      out.push(`the hill is closed and ${timers.length} ${HILL_OPEN} events are queued, not 1`);
    }
    const config = HillTimeSchema.safeParse(r.config);
    for (const e of timers) {
      if (e.ref !== "") out.push(`${HILL_OPEN} (seq ${e.seq}) has ref "${e.ref}", not ""`);
      if (config.success && e.at !== config.data.time.hillOpen) {
        out.push(
          `${HILL_OPEN} (seq ${e.seq}) is at ${e.at}, not at time.hillOpen (${config.data.time.hillOpen})`,
        );
      }
    }
    return out;
  },
};

/** Every city has an owner: sandbox-1 has no neutral city. */
const ownedCities: Invariant = {
  name: "sandbox.owned-cities",
  level: "step",
  check(r: ReadCtx): readonly string[] {
    return Object.values(r.state.cities)
      .filter((c) => c.owner === null)
      .map((c) => c.id)
      .toSorted(compareIds)
      .map((id) => `${id} is neutral; sandbox-1 has no neutral city`);
  },
};

/** No stationed group holds a city against its owner: sandbox-1 has no sieges. */
const noHold: Invariant = {
  name: "sandbox.no-hold",
  level: "step",
  check(r: ReadCtx): readonly string[] {
    const out: string[] = [];
    for (const c of Object.values(r.state.cities).toSorted((a, b) => compareIds(a.id, b.id))) {
      for (const g of c.stationed) {
        if (g.role === "hold") out.push(`${c.id} has a hold group of ${g.owner} from ${g.home}`);
      }
    }
    return out;
  },
};

/** `hooks.invariants`. */
export const SANDBOX_INVARIANTS: readonly Invariant[] = Object.freeze([
  hillTimer,
  ownedCities,
  noHold,
]);
