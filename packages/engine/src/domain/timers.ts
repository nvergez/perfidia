// Queue completions (docs/architecture.md §5.1, §5.4; perfidia-1 §5.3, §6.3): `build_done` and
// `recruit_done`, whose event ref is the city and whose seq is the item's. Each emits its standard
// event and, only when it empties its queue, `queue_empty` (through `std`). The diplomacy timers
// (`proposal_expire`, `pact_expire`) live with the diplomacy handlers.

import type { Ctx } from "@perfidia/engine/contracts";
import { completeBuild, completeRecruit } from "@perfidia/engine/std";
import type { ScheduledEvent } from "@perfidia/protocol";
import { DomainError, need } from "./common.ts";

/** `build_done`: the item with this seq completes: +1 on the building's current level, capped. */
export function buildDone(ctx: Ctx, ev: ScheduledEvent): void {
  const city = need(ctx.state.cities, ev.ref, "city");
  const item = city.build.find((x) => x.seq === ev.seq);
  if (item === undefined) throw new DomainError(`${city.id} has no build item with seq ${ev.seq}`);
  completeBuild(ctx, city.id, item.id);
}

/** `recruit_done`: the batch with this seq completes: its remaining units are home. */
export function recruitDone(ctx: Ctx, ev: ScheduledEvent): void {
  const city = need(ctx.state.cities, ev.ref, "city");
  for (const q of ctx.rules.queues.recruit) {
    const batch = (city.recruit[q.id] ?? []).find((x) => x.seq === ev.seq);
    if (batch !== undefined) {
      completeRecruit(ctx, city.id, batch.id);
      return;
    }
  }
  throw new DomainError(`${city.id} has no recruit batch with seq ${ev.seq}`);
}
