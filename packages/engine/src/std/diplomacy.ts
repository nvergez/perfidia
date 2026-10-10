// Default relation model (docs/architecture.md §5.4): named blocs (`player.alliance`) and bilateral
// pacts. Everything else in the engine and the gateway asks `relationsOf`/`relation` (derive.ts),
// which call `hooks.relations` first, so a ruleset with another model replaces this one.

import {
  compareIds,
  type AllianceId,
  type DeepReadonly,
  type Pact,
  type PlayerId,
  type Recipient,
} from "@perfidia/protocol";
import type { Ctx, ReadCtx, Relation } from "@perfidia/engine/contracts";
import { cancelIfQueued, emitTo, fail, must } from "./util.ts";

/** Alliance members (`ally`) and pact partners (`pact`, with the pact's expiry) of `p`, by player. */
export const defaultRelations = (r: ReadCtx, p: PlayerId): readonly Relation[] => {
  const out: Relation[] = [];
  const player = r.state.players[p];
  const allianceId = player?.alliance ?? null;
  if (allianceId !== null) {
    const alliance = r.state.alliances[allianceId];
    for (const member of alliance?.members ?? []) {
      if (member !== p) out.push({ player: member, kind: "ally", until: null });
    }
  }
  for (const pact of r.state.pacts) {
    const other = pact.a === p ? pact.b : pact.b === p ? pact.a : null;
    if (other !== null) out.push({ player: other, kind: "pact", until: pact.expiresAt });
  }
  return out.toSorted(
    (x, y) =>
      compareIds(x.player, y.player) || (x.kind === y.kind ? 0 : x.kind === "ally" ? -1 : 1),
  );
};

function memberRecipients(members: readonly PlayerId[], self: PlayerId): Recipient[] {
  const out: Recipient[] = [{ p: self, as: "self" }];
  for (const m of members) if (m !== self) out.push({ p: m, as: "ally" });
  return out;
}

/**
 * `p` leaves its alliance at once (public `alliance_left`). An alliance left with one member
 * dissolves (public `alliance_dissolved`), and that member is unallied. No-op when `p` is unallied.
 */
export function leaveAlliance(
  ctx: Ctx,
  p: PlayerId,
  cause: "left" | "betrayal" | "eliminated",
): void {
  const player = must(ctx.state.players[p], `player ${p}`);
  const id: AllianceId | null = player.alliance;
  if (id === null) return;
  const alliance = must(ctx.state.alliances[id], `alliance ${id}`);
  const before = [...alliance.members];
  alliance.members = alliance.members.filter((m) => m !== p);
  player.alliance = null;
  emitTo(
    ctx,
    "alliance_left",
    { alliance: id, player: p, cause },
    memberRecipients(before, p),
    true,
  );
  if (alliance.members.length <= 1) {
    const rest = [...alliance.members];
    for (const m of rest) must(ctx.state.players[m], `player ${m}`).alliance = null;
    delete ctx.state.alliances[id];
    emitTo(
      ctx,
      "alliance_dissolved",
      { alliance: id },
      rest.map((m): Recipient => ({ p: m, as: "self" })),
      true,
    );
  }
}

function pactIndex(pacts: readonly DeepReadonly<Pact>[], a: PlayerId, b: PlayerId): number {
  return pacts.findIndex((x) => (x.a === a && x.b === b) || (x.a === b && x.b === a));
}

/**
 * Ends the pact between `a` and `b` and cancels its expiry event if still queued. `a` is addressed
 * as `self` (the actor: the leaver, the betrayer) and `b` as `target`. Cause `expired` emits the
 * public `pact_expired`; every other cause the public `pact_ended` with its cause.
 */
export function endPact(
  ctx: Ctx,
  a: PlayerId,
  b: PlayerId,
  cause: "left" | "betrayal" | "expired" | "eliminated" | "superseded",
): void {
  const i = pactIndex(ctx.state.pacts, a, b);
  if (i < 0) fail(`no pact between ${a} and ${b}`);
  const [pact] = ctx.state.pacts.splice(i, 1);
  if (pact === undefined) fail(`no pact between ${a} and ${b}`);
  if (pact.seq !== null) cancelIfQueued(ctx, pact.seq);
  const to: Recipient[] = [
    { p: a, as: "self" },
    { p: b, as: "target" },
  ];
  if (cause === "expired") emitTo(ctx, "pact_expired", { a: pact.a, b: pact.b }, to, true);
  else emitTo(ctx, "pact_ended", { a: pact.a, b: pact.b, cause }, to, true);
}

/** Deletes every open proposal from or to `p` and cancels their expiry events. Emits nothing. */
export function cancelProposalsOf(ctx: Ctx, p: PlayerId): void {
  const doomed = Object.values(ctx.state.proposals)
    .filter((q) => q.from === p || q.to === p)
    .toSorted((x, y) => compareIds(x.id, y.id));
  for (const q of doomed) {
    cancelIfQueued(ctx, q.seq);
    delete ctx.state.proposals[q.id];
  }
}
