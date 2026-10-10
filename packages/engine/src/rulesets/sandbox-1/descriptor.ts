import type { Ruleset } from "@perfidia/engine/contracts";
import { arriveAttack } from "./attack.ts";
import { renderCheatSheet } from "./cheatsheet.ts";
import { compileRules, HILL_OPEN } from "./compile.ts";
import {
  playerRange,
  SANDBOX_1_DEFAULTS,
  SANDBOX_1_ID,
  SANDBOX_1_REF,
  SANDBOX_1_VERSION,
  SandboxConfigSchema,
  type SandboxConfig,
} from "./config.ts";
import { SANDBOX_1_ERROR_SAMPLES, SANDBOX_1_ERRORS } from "./errors.ts";
import { SandboxExtSchema, type SandboxExt } from "./ext.ts";
import { afterStep, finish, onHillOpen } from "./hill.ts";
import { SANDBOX_INVARIANTS } from "./invariants.ts";
import { createWorld } from "./map.ts";
import { standingsHook } from "./scoring.ts";
import { arriveSpy } from "./spy.ts";
import {
  CITY_RENAMED,
  CityRenamedSchema,
  extActionHandler,
  HILL_STATUS_TOOL,
  RENAME_CITY_TOOL,
} from "./tools.ts";
import { travelTime } from "./travel.ts";
import { SANDBOX_VISIBILITY } from "./visibility.ts";

// The descriptor of sandbox-1@1.0.0 (docs/architecture.md §3.2, §3.8), status `test`: `sim run`
// refuses it without `--allow-test`. It imports only `core`, contracts and `std` (the `domain`
// module is written in parallel and passed to the kernel), never another ruleset. Hooks it leaves
// out fall back to the defaults: `std.defaultDeparture`, the domain's support, shipment, found and
// return arrivals, `std.defaultRelations`, and std's visibility for city access and players.

export const sandbox1_1_0_0: Ruleset<SandboxConfig, SandboxExt> = {
  id: SANDBOX_1_ID,
  version: SANDBOX_1_VERSION,
  ref: SANDBOX_1_REF,
  status: "test",
  title: "sandbox-1 (coexistence test ruleset)",
  configSchema: SandboxConfigSchema,
  defaults: SANDBOX_1_DEFAULTS,
  extSchema: SandboxExtSchema,
  players: playerRange,
  compile: compileRules,
  cheatSheet: renderCheatSheet,
  hooks: {
    createWorld,
    travelTime,
    arrive: { attack: arriveAttack, spy: arriveSpy },
    on: { [HILL_OPEN]: onHillOpen },
    afterStep,
    standings: standingsHook,
    finish,
    visibility: SANDBOX_VISIBILITY,
    actions: { ext: extActionHandler },
    invariants: SANDBOX_INVARIANTS,
  },
  errors: SANDBOX_1_ERRORS,
  errorSamples: SANDBOX_1_ERROR_SAMPLES,
  tools: [HILL_STATUS_TOOL, RENAME_CITY_TOOL],
  eventSchemas: { [CITY_RENAMED]: CityRenamedSchema },
};
