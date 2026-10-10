import type { Ruleset } from "@perfidia/engine/contracts";
import { arriveFound, arriveShipment, arriveSpy, arriveSupport } from "./arrivals.ts";
import { arriveAttack, arriveReturn } from "./battle.ts";
import { checkConfig } from "./check.ts";
import { renderCheatSheet } from "./cheatsheet.ts";
import { compileRules } from "./compile.ts";
import {
  PERFIDIA_1_DEFAULTS,
  PERFIDIA_1_ID,
  PERFIDIA_1_REF,
  PERFIDIA_1_VERSION,
  type PerfidiaConfig,
  PerfidiaConfigSchema,
  playerRange,
} from "./config.ts";
import { departure, guard } from "./departure.ts";
import { PERFIDIA_1_ERROR_SAMPLES, PERFIDIA_1_ERRORS } from "./errors.ts";
import { PERFIDIA_1_EVENT_SCHEMAS, PERFIDIA_1_INTEL_EVENTS } from "./events.ts";
import { type PerfidiaExt, PerfidiaExtSchema } from "./ext.ts";
import { perfidiaInvariants } from "./invariants.ts";
import { DOMINATION_OPEN, createWorld } from "./map.ts";
import { SIEGE_END, onSiegeEnd } from "./siege.ts";
import { travelTime } from "./travel.ts";
import { perfidiaVisibility } from "./visibility.ts";
import {
  DOMINATION_END,
  afterStep,
  finish,
  onDominationEnd,
  onDominationOpen,
  standings,
} from "./victory.ts";

// The descriptor of `perfidia-1@1.0.0` (docs/rulesets/perfidia-1.md, docs/architecture.md §3.2).
// Published versions are frozen (§3.5): a behaviour change ships as a new descriptor file
// (`v1_1_0.ts`) that reuses the unchanged modules of this one.

/** `perfidia-1@1.0.0`, the active default ruleset. */
export const perfidia1_1_0_0: Ruleset<PerfidiaConfig, PerfidiaExt> = Object.freeze({
  id: PERFIDIA_1_ID,
  version: PERFIDIA_1_VERSION,
  ref: PERFIDIA_1_REF,
  status: "published",
  title: "Perfidia V1",
  configSchema: PerfidiaConfigSchema,
  defaults: PERFIDIA_1_DEFAULTS,
  extSchema: PerfidiaExtSchema,
  players: playerRange,
  compile: compileRules,
  check: checkConfig,
  cheatSheet: renderCheatSheet,
  hooks: Object.freeze({
    createWorld,
    travelTime,
    departure,
    arrive: Object.freeze({
      attack: arriveAttack,
      spy: arriveSpy,
      support: arriveSupport,
      shipment: arriveShipment,
      found: arriveFound,
      return: arriveReturn,
    }),
    on: Object.freeze({
      [SIEGE_END]: onSiegeEnd,
      [DOMINATION_OPEN]: onDominationOpen,
      [DOMINATION_END]: onDominationEnd,
    }),
    guard,
    afterStep,
    standings,
    finish,
    visibility: perfidiaVisibility,
    invariants: perfidiaInvariants,
  }),
  errors: PERFIDIA_1_ERRORS,
  errorSamples: PERFIDIA_1_ERROR_SAMPLES,
  eventSchemas: PERFIDIA_1_EVENT_SCHEMAS,
  intelEvents: PERFIDIA_1_INTEL_EVENTS,
});
