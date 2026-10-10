// @perfidia/engine/domain: the default action and event handlers (docs/architecture.md §5.2, §7),
// built on `std` and data-driven by `CompiledRules`. The kernel receives this module as an argument;
// the top barrel binds it. A ruleset replaces a handler through `hooks.actions`, an arrival through
// `hooks.arrive` and a scheduled event through `hooks.on`; it can reuse the pieces exported here.

import type { DomainModule } from "@perfidia/engine/contracts";
import { stdInvariants } from "@perfidia/engine/std";
import { arriveFound, arriveReturn, arriveShipment, arriveSupport } from "./arrivals.ts";
import {
  answer,
  diplomacyInvariants,
  leave,
  pactExpire,
  propose,
  proposalExpire,
  sendMessage,
} from "./diplomacy.ts";
import { build, cancelQueue, recruit } from "./economy.ts";
import { attack, foundCity, sendResources, spy, support } from "./military.ts";
import { dismiss, recall, recallStationed } from "./recall.ts";
import { buildDone, recruitDone } from "./timers.ts";

export { DomainError } from "./common.ts";
export { arriveFound, arriveReturn, arriveShipment, arriveSupport } from "./arrivals.ts";
export { buildDone, recruitDone } from "./timers.ts";
export {
  diplomacyInvariants,
  keepsDefaultDiplomacy,
  pactExpire,
  proposalExpire,
  type AnswerPlan,
  type LeavePlan,
  type MessagePlan,
  type ProposePlan,
} from "./diplomacy.ts";
export { recruitMax, type BuildPlan, type CancelPlan, type RecruitPlan } from "./economy.ts";
export { validateDeparture, type DepartureInput, type LaunchPlan } from "./military.ts";
export type { DismissPlan, GroupReturn, RecallPlan, RecallStationedPlan } from "./recall.ts";

/**
 * The default domain module: a handler for every action but `ext` (`domain.actions.build`, …), the
 * queue and diplomacy timers, the default arrivals, and the invariants of `std` plus the bloc
 * invariants (which switch themselves off when the ruleset replaces `propose`, `answer` or `leave`).
 */
export const domain: DomainModule = Object.freeze({
  actions: Object.freeze({
    build,
    recruit,
    cancel_queue: cancelQueue,
    send_resources: sendResources,
    attack,
    support,
    spy,
    found_city: foundCity,
    recall,
    recall_stationed: recallStationed,
    dismiss,
    send_message: sendMessage,
    propose,
    answer,
    leave,
  }),
  events: Object.freeze({
    build_done: buildDone,
    recruit_done: recruitDone,
    proposal_expire: proposalExpire,
    pact_expire: pactExpire,
  }),
  arrivals: Object.freeze({
    support: arriveSupport,
    shipment: arriveShipment,
    found: arriveFound,
    return: arriveReturn,
  }),
  invariants: Object.freeze([...stdInvariants, ...diplomacyInvariants]),
});
