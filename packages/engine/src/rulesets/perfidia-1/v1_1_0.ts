import type { Ruleset } from "@perfidia/engine/contracts";
import { arriveFound, arriveShipment, arriveSpy, arriveSupport } from "./arrivals.ts";
import { arriveAttack, arriveReturn } from "./battle.ts";
import { checkConfig11 } from "./check_1_1.ts";
import { renderCheatSheet11 } from "./cheatsheet_1_1.ts";
import { compileRulesWith } from "./compiler.ts";
import { PERFIDIA_1_ID } from "./config.ts";
import {
  PERFIDIA_1_1_DEFAULTS,
  PERFIDIA_1_1_REF,
  PERFIDIA_1_1_VERSION,
  type Perfidia11Config,
  Perfidia11ConfigSchema,
} from "./config_1_1.ts";
import { departure, guard } from "./departure.ts";
import { PERFIDIA_1_ERROR_SAMPLES, PERFIDIA_1_ERRORS } from "./errors.ts";
import { PERFIDIA_1_INTEL_EVENTS } from "./events.ts";
import { PERFIDIA_1_1_EVENT_SCHEMAS } from "./events_1_1.ts";
import { initialExt11, type Perfidia11Ext, Perfidia11ExtSchema } from "./ext_1_1.ts";
import { perfidia11Invariants } from "./invariants_1_1.ts";
import { NAMES_1_1_0 } from "./names.ts";
import { playerRange } from "./schema.ts";
import { SIEGE_END } from "./siege.ts";
import { travelTime } from "./travel.ts";
import { DOMINATION_END, onDominationOpen } from "./victory.ts";
import {
  afterStep11,
  finish11,
  onDominationEnd11,
  onSiegeEnd11,
  standings11,
} from "./victory_1_1.ts";
import { perfidia11Visibility } from "./visibility_1_1.ts";
import { createWorldWith, DOMINATION_OPEN } from "./world.ts";

// The descriptor of `perfidia-1@1.1.0` (docs/rulesets/perfidia-1.md §0.1). It reuses 1.0.0's
// unchanged modules: travel, departures, arrivals, battles, sieges, errors and the domination
// opening. What changed is in the `*_1_1.ts` modules: the ids of the Greek setting, domination by
// conquest (the threshold counts the map's city slots and needs taken cities), the bounds and
// cross-checks of the domination keys, and the conquest trophy of the score.

/** `perfidia-1@1.1.0`, the default perfidia-1. */
export const perfidia1_1_1_0: Ruleset<Perfidia11Config, Perfidia11Ext> = Object.freeze({
  id: PERFIDIA_1_ID,
  version: PERFIDIA_1_1_VERSION,
  ref: PERFIDIA_1_1_REF,
  status: "published",
  title: "Perfidia V1.1",
  configSchema: Perfidia11ConfigSchema,
  defaults: PERFIDIA_1_1_DEFAULTS,
  extSchema: Perfidia11ExtSchema,
  players: playerRange,
  compile: compileRulesWith(NAMES_1_1_0),
  check: checkConfig11,
  cheatSheet: renderCheatSheet11,
  hooks: Object.freeze({
    createWorld: createWorldWith(NAMES_1_1_0, initialExt11),
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
      [SIEGE_END]: onSiegeEnd11,
      [DOMINATION_OPEN]: onDominationOpen,
      [DOMINATION_END]: onDominationEnd11,
    }),
    guard,
    afterStep: afterStep11,
    standings: standings11,
    finish: finish11,
    visibility: perfidia11Visibility,
    invariants: perfidia11Invariants,
  }),
  errors: PERFIDIA_1_ERRORS,
  errorSamples: PERFIDIA_1_ERROR_SAMPLES,
  eventSchemas: PERFIDIA_1_1_EVENT_SCHEMAS,
  intelEvents: PERFIDIA_1_INTEL_EVENTS,
});
