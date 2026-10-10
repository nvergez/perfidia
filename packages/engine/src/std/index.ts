// @perfidia/engine/std: the shared game model every ruleset builds on (docs/architecture.md §5.4).
// Derivations take a `ReadCtx` and never write; primitives take a `Ctx`, materialise what they
// touch and emit the standard events. std reads only `CompiledRules`, never a ruleset's raw config
// or id.

export {
  BUILD_QUEUE,
  accrualPerSecond,
  affordableAt,
  citiesOf,
  fallbackCity,
  freeSlots,
  inFlightCargo,
  insufficientResources,
  isHeldAgainst,
  maxAffordable,
  popCap,
  popUsed,
  queueEtas,
  rates,
  relation,
  relationsOf,
  settlerK,
  sortedIds,
  stockAt,
  stockSecondsAt,
  storageCap,
  travel,
  trickledAt,
  unitCost,
  unitsAtHome,
  type QueueEta,
} from "./derive.ts";
export { addCapped, materialize, setLevel, spend } from "./stock.ts";
export { putHome, removeUnits, spawnUnits, takeHome, type UnitSlot } from "./units.ts";
export { allocateLosses, slotUnits, stackGroups } from "./losses.ts";
export {
  arriveHome,
  bounce,
  deleteMovement,
  deliverShipment,
  deliverSupport,
  launch,
  startReturn,
  station,
  turnBack,
  unstation,
  type ReturnSpec,
} from "./movement.ts";
export {
  cancelFrom,
  clearQueues,
  completeBuild,
  completeRecruit,
  enqueueBuild,
  enqueueRecruit,
  reflowQueue,
  removeQueueItems,
} from "./queues.ts";
export { disbandHomed, eliminate, foundCity, rehomeAll, transferCity } from "./cities.ts";
export { cancelProposalsOf, defaultRelations, endPact, leaveAlliance } from "./diplomacy.ts";
export { defaultDeparture, defaultVisibility } from "./visibility.ts";
export { incomingAudience, recipients } from "./audience.ts";
export { checkStd, stdInvariants } from "./invariants.ts";
export {
  StdError,
  buildingTable,
  cleanUnits,
  hasUnits,
  unitTable,
  unitTotal,
  unitsPop,
} from "./util.ts";
