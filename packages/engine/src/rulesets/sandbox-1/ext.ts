import { z } from "@perfidia/protocol";

// `state.ext` of sandbox-1 (docs/architecture.md §3.8): the hill flag, set by the `hill_open` world
// timer and read by `afterStep` (§3.1: time-gated conditions are driven by a scheduled event, never
// by comparing `now` with a threshold).

export const SandboxExtSchema = z.strictObject({
  /** Whether the hill victory is open (the `hill_open` timer has fired). */
  hillOpen: z.boolean(),
});
export type SandboxExt = z.infer<typeof SandboxExtSchema>;

/** The `ext` of a new world. */
export function initialExt(): SandboxExt {
  return { hillOpen: false };
}
