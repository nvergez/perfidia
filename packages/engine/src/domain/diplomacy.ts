// Diplomacy (docs/architecture.md §7.1, §5.4; perfidia-1 §11.1–11.4, generic parts): messages,
// proposals, answers and leaving, on the default relation model of `std` (named blocs in
// `player.alliance`, bilateral pacts). Whether two players are allies or pact partners is decided
// through `std.relation`/`relationsOf`; the records are read only for what the model itself is
// made of (which alliance, how many members). Nothing is binding (§11 of perfidia-1).
//
// A ruleset with another relation model replaces `hooks.relations` and these three handlers
// (`propose`, `answer`, `leave`); the bloc invariants below then switch themselves off.

import type { Ctx, Invariant, ReadCtx } from "@perfidia/engine/contracts";
import {
  endPact,
  leaveAlliance,
  recipients,
  relation,
  relationsOf,
  sortedIds,
} from "@perfidia/engine/std";
import {
  compareIds,
  type ActionOf,
  type Alliance,
  type AllianceId,
  type DeepReadonly,
  type GameTime,
  type Pact,
  type PlayerId,
  type Proposal,
  type ProposalId,
} from "@perfidia/protocol";
import {
  DomainError,
  handler,
  lookup,
  need,
  pair,
  reject,
  type Rejection,
  type Verdict,
} from "./common.ts";

/**
 * A living player other than the seat, or the rejection naming why not. `INVALID_TARGET` names the
 * `action` it rejects, so that an explanation fits a message as well as a proposal.
 */
function counterpart(
  r: ReadCtx,
  seat: PlayerId,
  p: PlayerId,
  action: "send_message" | "propose",
): Rejection | null {
  const player = lookup(r.state.players, p);
  if (player === undefined) return reject("UNKNOWN_ID", { player: p });
  if (p === seat) return reject("INVALID_TARGET", { player: p, action, reason: "self" });
  if (!player.alive) return reject("INVALID_TARGET", { player: p, action, reason: "eliminated" });
  return null;
}

/** `INVALID_ARGS` for an `until` that is not strictly in the future (at propose or acceptance). */
function untilPast(until: GameTime, now: GameTime): Rejection {
  return reject("INVALID_ARGS", { field: "until", until, now, reason: "past" });
}

function pactKey(a: PlayerId, b: PlayerId): string {
  return `${a}|${b}`;
}

function sortedPair(x: PlayerId, y: PlayerId): [PlayerId, PlayerId] {
  return compareIds(x, y) < 0 ? [x, y] : [y, x];
}

function findPact(r: ReadCtx, x: PlayerId, y: PlayerId): DeepReadonly<Pact> | undefined {
  const [a, b] = sortedPair(x, y);
  return r.state.pacts.find((p) => p.a === a && p.b === b);
}

function comparePacts(u: DeepReadonly<Pact>, v: DeepReadonly<Pact>): number {
  return compareIds(u.a, v.a) || compareIds(u.b, v.b);
}

/** The alliance record of `p`, or null. */
function allianceOf(r: ReadCtx, p: PlayerId): DeepReadonly<Alliance> | null {
  const id = lookup(r.state.players, p)?.alliance ?? null;
  return id === null ? null : (lookup(r.state.alliances, id) ?? null);
}

// send_message ------------------------------------------------------------------------------------

export interface MessagePlan {
  /** Sorted, unique; `"all"` for a public message. */
  readonly to: PlayerId[] | "all";
  readonly text: string;
}

/**
 * `send_message {to, text}`: a private message to living players (sorted, duplicates dropped), or a
 * public one to `"all"`; at most `diplomacy.messageMaxChars` characters. The `message` event carries
 * the text (it is never stored): to the sender as `self` and each recipient as `target`, public for
 * `"all"`. The daily cap is the gateway's.
 */
export const sendMessage = handler<ActionOf<"send_message">, MessagePlan>({
  validate(r, seat, a): Verdict<MessagePlan> {
    const max = r.rules.diplomacy.messageMaxChars;
    if (a.text.length > max) {
      return reject("TEXT_TOO_LONG", { field: "text", max, length: a.text.length });
    }
    if (a.to === "all") return { ok: true, plan: { to: "all", text: a.text } };
    const to = [...new Set(a.to)].toSorted(compareIds);
    for (const p of to) {
      const bad = counterpart(r, seat, p, "send_message");
      if (bad !== null) return bad;
    }
    return { ok: true, plan: { to, text: a.text } };
  },
  apply(ctx, seat, plan) {
    const id = ctx.nextId("g", seat);
    const to = plan.to === "all" ? [] : plan.to.map((p) => [p, "target"] as const);
    ctx.emit({
      type: "message",
      public: plan.to === "all",
      to: recipients([[seat, "self"], ...to]),
      data: {
        message: id,
        from: seat,
        to: plan.to === "all" ? "all" : [...plan.to],
        text: plan.text,
      },
    });
    return { message: id, to: plan.to === "all" ? "all" : [...plan.to] };
  },
});

// propose -----------------------------------------------------------------------------------------

export interface ProposePlan {
  readonly to: PlayerId;
  readonly kind: "alliance" | "pact";
  readonly name: string | null;
  readonly text: string;
  readonly until: GameTime | null;
  readonly expiresAt: GameTime;
}

/**
 * `propose {to, kind, name, text, until}`: to a living player who is not already an ally; a name
 * only for an alliance (≤ `allianceNameMaxChars`), a text ≤ `proposalTextMaxChars`; `until` only for
 * a pact and only with `toolOptions.pactUntil`, strictly in the future. At most
 * `maxOpenProposals` open outgoing proposals and one per (from, to, kind). Acceptance conditions
 * (sizes, pact limits) are checked when the proposal is answered. Expires after `proposalTtl`.
 *
 * `INVALID_ARGS` says why with `reason`: `unsupported` (an optional field the ruleset does not
 * accept, §3.7), `wrong_kind` (a field of the other kind) or `past` (an `until` already reached).
 * `PROPOSAL_LIMIT` says why with `reason`: `duplicate` (an open proposal to `to` of this `kind`,
 * `availableAt` its expiry) or `max_open` (`availableAt` the first expiry; `null` = never, when
 * `maxOpenProposals` is 0).
 */
export const propose = handler<ActionOf<"propose">, ProposePlan>({
  validate(r, seat, a): Verdict<ProposePlan> {
    const bad = counterpart(r, seat, a.to, "propose");
    if (bad !== null) return bad;
    const d = r.rules.diplomacy;
    if (a.text.length > d.proposalTextMaxChars) {
      return reject("TEXT_TOO_LONG", {
        field: "text",
        max: d.proposalTextMaxChars,
        length: a.text.length,
      });
    }
    if (a.name !== null) {
      if (a.kind !== "alliance") {
        return reject("INVALID_ARGS", { field: "name", kind: a.kind, reason: "wrong_kind" });
      }
      if (a.name.length > d.allianceNameMaxChars) {
        return reject("TEXT_TOO_LONG", {
          field: "name",
          max: d.allianceNameMaxChars,
          length: a.name.length,
        });
      }
    }
    if (a.until !== null) {
      if (!r.rules.toolOptions.pactUntil) {
        return reject("INVALID_ARGS", {
          field: "until",
          ruleset: r.rules.ruleset,
          reason: "unsupported",
        });
      }
      if (a.kind !== "pact") {
        return reject("INVALID_ARGS", { field: "until", kind: a.kind, reason: "wrong_kind" });
      }
      if (a.until <= r.now) return untilPast(a.until, r.now);
    }
    if (relation(r, seat, a.to) === "ally") {
      return reject("ALREADY_ALLIED", { player: a.to, kind: a.kind });
    }
    const mine = sortedIds(r.state.proposals)
      .map((id) => r.state.proposals[id])
      .filter((p): p is DeepReadonly<Proposal> => p !== undefined && p.from === seat);
    const max = d.maxOpenProposals;
    const same = mine.find((p) => p.to === a.to && p.kind === a.kind);
    if (same !== undefined) {
      return reject("PROPOSAL_LIMIT", {
        to: a.to,
        kind: a.kind,
        proposal: same.id,
        reason: "duplicate",
        open: mine.length,
        max,
        availableAt: same.expiresAt,
      });
    }
    if (mine.length >= max) {
      // `mine` is empty only when the limit is 0: no slot ever frees.
      const first = mine.reduce<GameTime | null>(
        (t, p) => (t === null || p.expiresAt < t ? p.expiresAt : t),
        null,
      );
      return reject("PROPOSAL_LIMIT", {
        reason: "max_open",
        open: mine.length,
        max,
        availableAt: first,
      });
    }
    return {
      ok: true,
      plan: {
        to: a.to,
        kind: a.kind,
        name: a.name,
        text: a.text,
        until: a.until,
        expiresAt: r.now + d.proposalTtl,
      },
    };
  },
  apply(ctx, seat, plan) {
    const id = ctx.nextId("q", seat);
    const seq = ctx.schedule("proposal_expire", plan.expiresAt, id);
    ctx.state.proposals[id] = {
      id,
      from: seat,
      to: plan.to,
      kind: plan.kind,
      name: plan.name,
      until: plan.until,
      expiresAt: plan.expiresAt,
      seq,
    };
    ctx.emit({
      type: "proposal",
      public: false,
      to: recipients([
        [seat, "self"],
        [plan.to, "target"],
      ]),
      data: {
        proposal: id,
        from: seat,
        to: plan.to,
        kind: plan.kind,
        name: plan.name,
        text: plan.text,
        until: plan.until,
        expiresAt: plan.expiresAt,
      },
    });
    return { proposal: id, expires: pair(plan.expiresAt) };
  },
});

// answer ------------------------------------------------------------------------------------------

/** What an accepted proposal does. */
type Outcome =
  | { readonly kind: "form"; readonly name: string | null }
  | { readonly kind: "join"; readonly alliance: AllianceId; readonly joiner: PlayerId }
  | { readonly kind: "pact"; readonly renew: boolean; readonly expiresAt: GameTime | null };

export interface AnswerPlan {
  readonly proposal: ProposalId;
  readonly accept: boolean;
  /** `null` for a refusal. */
  readonly outcome: Outcome | null;
}

/** Re-checks an alliance proposal at acceptance (§11.3 of perfidia-1). */
function allianceOutcome(r: ReadCtx, p: DeepReadonly<Proposal>): Rejection | Outcome {
  if (relation(r, p.to, p.from) === "ally") {
    return reject("ALREADY_ALLIED", { player: p.from, kind: p.kind });
  }
  const mine = allianceOf(r, p.to);
  const theirs = allianceOf(r, p.from);
  const max = r.rules.diplomacy.allianceMax;
  if (mine !== null && theirs !== null) {
    return reject("ALREADY_ALLIED", {
      player: p.from,
      kind: p.kind,
      reason: "both_allied",
      alliance: theirs.id,
      yours: mine.id,
    });
  }
  const host = mine ?? theirs;
  if (host === null) {
    if (max < 2) return reject("ALLIANCE_FULL", { alliance: null, max, members: 0 });
    return { kind: "form", name: p.name };
  }
  if (host.members.length >= max) {
    return reject("ALLIANCE_FULL", { alliance: host.id, max, members: host.members.length });
  }
  return { kind: "join", alliance: host.id, joiner: mine === null ? p.to : p.from };
}

/** Re-checks a pact proposal at acceptance (§11.4 of perfidia-1); a renewal does not count. */
function pactOutcome(r: ReadCtx, p: DeepReadonly<Proposal>): Rejection | Outcome {
  if (relation(r, p.to, p.from) === "ally") {
    return reject("ALREADY_ALLIED", { player: p.from, kind: p.kind });
  }
  const d = r.rules.diplomacy;
  if (p.until !== null && p.until <= r.now) return untilPast(p.until, r.now);
  const expiresAt = p.until ?? (d.pactDuration === null ? null : r.now + d.pactDuration);
  if (findPact(r, p.from, p.to) !== undefined) return { kind: "pact", renew: true, expiresAt };
  for (const who of [p.to, p.from]) {
    const pacts = relationsOf(r, who).filter((x) => x.kind === "pact");
    if (pacts.length >= d.maxPacts) {
      // A slot frees when the first of `who`'s pacts expires (pacts are public); null: never.
      const ends = pacts.map((x) => x.until).filter((t): t is GameTime => t !== null);
      return reject("PACT_LIMIT", {
        player: who,
        max: d.maxPacts,
        pacts: pacts.length,
        availableAt: ends.length === 0 ? null : Math.min(...ends),
      });
    }
  }
  return { kind: "pact", renew: false, expiresAt };
}

/** Ends every pact between `joiner` and another member of `alliance`: cause `superseded`. */
function supersedePacts(ctx: Ctx, joiner: PlayerId, members: readonly PlayerId[]): void {
  for (const m of members) {
    if (m !== joiner && findPact(ctx.read(), joiner, m) !== undefined) {
      endPact(ctx, joiner, m, "superseded");
    }
  }
}

function formAlliance(ctx: Ctx, p: DeepReadonly<Proposal>, name: string | null): AllianceId {
  const id = ctx.nextId("a");
  const members = [p.from, p.to].toSorted(compareIds);
  const alliance: Alliance = { id, name: name ?? id, members, formedAt: ctx.now };
  ctx.state.alliances[id] = alliance;
  for (const m of members) need(ctx.state.players, m, "player").alliance = id;
  ctx.emit({
    type: "alliance_formed",
    public: true,
    to: recipients([
      [p.to, "self"],
      [p.from, "target"],
    ]),
    data: { alliance: id, name: alliance.name, members: [...members] },
  });
  supersedePacts(ctx, p.to, members);
  return id;
}

function joinAlliance(ctx: Ctx, id: AllianceId, joiner: PlayerId): void {
  const alliance = need(ctx.state.alliances, id, "alliance");
  alliance.members = [...alliance.members, joiner].toSorted(compareIds);
  need(ctx.state.players, joiner, "player").alliance = id;
  ctx.emit({
    type: "alliance_joined",
    public: true,
    to: recipients([[joiner, "self"], ...alliance.members.map((m) => [m, "ally"] as const)]),
    data: { alliance: id, player: joiner },
  });
  supersedePacts(ctx, joiner, alliance.members);
}

function signPact(
  ctx: Ctx,
  p: DeepReadonly<Proposal>,
  renew: boolean,
  expiresAt: GameTime | null,
): void {
  const [a, b] = sortedPair(p.from, p.to);
  const to = recipients([
    [p.to, "self"],
    [p.from, "target"],
  ]);
  if (renew) {
    const pact = ctx.state.pacts.find((x) => x.a === a && x.b === b);
    if (pact === undefined) throw new DomainError(`no pact ${pactKey(a, b)} to renew`);
    if (pact.seq !== null) ctx.cancel(pact.seq);
    pact.expiresAt = expiresAt;
    pact.seq = expiresAt === null ? null : ctx.schedule("pact_expire", expiresAt, pactKey(a, b));
    ctx.emit({ type: "pact_renewed", public: true, to, data: { a, b, expiresAt } });
    return;
  }
  const seq = expiresAt === null ? null : ctx.schedule("pact_expire", expiresAt, pactKey(a, b));
  ctx.state.pacts = [...ctx.state.pacts, { a, b, since: ctx.now, expiresAt, seq }].toSorted(
    comparePacts,
  );
  ctx.emit({ type: "pact_signed", public: true, to, data: { a, b, expiresAt } });
}

/**
 * `answer {proposal, accept}`: only the addressee answers; a proposal that does not exist or is not
 * addressed to the seat answers `PROPOSAL_NOT_FOUND` (an own proposal: `INVALID_TARGET`). A refusal
 * closes it. An acceptance re-checks every condition (§11.2 of perfidia-1); when one fails, the
 * proposal stays open:
 *
 * - alliance: not already allies; not both allied; the joined alliance below `allianceMax`. Neither
 *   allied: a new alliance named by the proposer (or its id); one allied: the other joins. Every
 *   pact between the joining player(s) and a member of the resulting alliance ends (`superseded`).
 * - pact: not allies; `until` still ahead; a new pact needs both players below `maxPacts`, while a
 *   renewal (an existing pact) does not count, and restarts its expiry.
 */
export const answer = handler<ActionOf<"answer">, AnswerPlan>({
  validate(r, seat, a): Verdict<AnswerPlan> {
    const p = lookup(r.state.proposals, a.proposal);
    if (p === undefined || (p.to !== seat && p.from !== seat)) {
      return reject("PROPOSAL_NOT_FOUND", { proposal: a.proposal });
    }
    if (p.to !== seat) {
      return reject("INVALID_TARGET", {
        proposal: a.proposal,
        action: "answer",
        reason: "own_proposal",
      });
    }
    if (!a.accept)
      return { ok: true, plan: { proposal: a.proposal, accept: false, outcome: null } };
    const outcome = p.kind === "alliance" ? allianceOutcome(r, p) : pactOutcome(r, p);
    if ("ok" in outcome) return outcome;
    return { ok: true, plan: { proposal: a.proposal, accept: true, outcome } };
  },
  apply(ctx, _seat, plan) {
    const p = need(ctx.state.proposals, plan.proposal, "proposal");
    ctx.cancel(p.seq);
    delete ctx.state.proposals[p.id];
    ctx.emit({
      type: "proposal_answered",
      public: false,
      to: recipients([
        [p.to, "self"],
        [p.from, "target"],
      ]),
      data: { proposal: p.id, from: p.from, to: p.to, kind: p.kind, accept: plan.accept },
    });
    const o = plan.outcome;
    if (o === null) return { proposal: p.id, accept: false };
    if (o.kind === "form") {
      return { proposal: p.id, accept: true, alliance: formAlliance(ctx, p, o.name) };
    }
    if (o.kind === "join") {
      joinAlliance(ctx, o.alliance, o.joiner);
      return { proposal: p.id, accept: true, alliance: o.alliance };
    }
    signPact(ctx, p, o.renew, o.expiresAt);
    const expires = o.expiresAt === null ? null : pair(o.expiresAt);
    return { proposal: p.id, accept: true, pact: p.from, renewed: o.renew, expires };
  },
});

// leave -------------------------------------------------------------------------------------------

export type LeavePlan =
  | { readonly leave: "alliance"; readonly alliance: AllianceId }
  | { readonly leave: "pact"; readonly with: PlayerId };

/**
 * `leave {with}`: without `with`, leave the seat's alliance (`NOT_IN_ALLIANCE` when it has none);
 * naming an ally also leaves the alliance; naming a pact partner ends that pact at once (public,
 * cause `left`); anyone else is `PACT_NOT_FOUND`. An alliance left with one member dissolves.
 */
export const leave = handler<ActionOf<"leave">, LeavePlan>({
  validate(r, seat, a): Verdict<LeavePlan> {
    if (a.with !== null) {
      if (lookup(r.state.players, a.with) === undefined) {
        return reject("UNKNOWN_ID", { player: a.with });
      }
      if (a.with === seat) {
        return reject("INVALID_TARGET", { player: a.with, action: "leave", reason: "self" });
      }
      const rel = relation(r, seat, a.with);
      if (rel === "pact") return { ok: true, plan: { leave: "pact", with: a.with } };
      if (rel !== "ally") return reject("PACT_NOT_FOUND", { player: a.with });
    }
    const alliance = allianceOf(r, seat);
    if (alliance === null) return reject("NOT_IN_ALLIANCE", { player: seat });
    return { ok: true, plan: { leave: "alliance", alliance: alliance.id } };
  },
  apply(ctx, seat, plan) {
    if (plan.leave === "pact") {
      endPact(ctx, seat, plan.with, "left");
      return { left: "pact", with: plan.with };
    }
    leaveAlliance(ctx, seat, "left");
    return { left: "alliance", alliance: plan.alliance };
  },
});

// Scheduled events --------------------------------------------------------------------------------

/** `proposal_expire`: the proposal closes unanswered; `proposal_expired` to both players. */
export function proposalExpire(ctx: Ctx, ev: { readonly seq: number; readonly ref: string }): void {
  const p = need(ctx.state.proposals, ev.ref, "proposal");
  if (p.seq !== ev.seq) throw new DomainError(`proposal ${p.id} expires with seq ${p.seq}`);
  delete ctx.state.proposals[p.id];
  ctx.emit({
    type: "proposal_expired",
    public: false,
    to: recipients([
      [p.from, "self"],
      [p.to, "target"],
    ]),
    data: { proposal: p.id, from: p.from, to: p.to, kind: p.kind },
  });
}

/** `pact_expire`: the pact `a|b` ends (public `pact_expired`). */
export function pactExpire(ctx: Ctx, ev: { readonly seq: number; readonly ref: string }): void {
  const pact = ctx.state.pacts.find((x) => pactKey(x.a, x.b) === ev.ref);
  if (pact === undefined || pact.seq !== ev.seq) {
    throw new DomainError(`pact_expire ${ev.ref} (seq ${ev.seq}) has no matching pact`);
  }
  endPact(ctx, pact.a, pact.b, "expired");
}

// Invariants (§13.3) ------------------------------------------------------------------------------

/** Whether the ruleset keeps the default `propose`, `answer` and `leave` handlers. */
export function keepsDefaultDiplomacy(r: ReadCtx): boolean {
  const own = r.ruleset.hooks.actions;
  return own?.propose === undefined && own?.answer === undefined && own?.leave === undefined;
}

function checkAlliances(r: ReadCtx): string[] {
  const out: string[] = [];
  const max = r.rules.diplomacy.allianceMax;
  for (const id of sortedIds(r.state.alliances)) {
    const a = r.state.alliances[id];
    if (a === undefined) continue;
    if (a.members.length < 2)
      out.push(`${id} has ${a.members.length} member(s); it dissolves at 1`);
    if (a.members.length > max) out.push(`${id} has ${a.members.length} members, above ${max}`);
    a.members.forEach((m, i) => {
      const prev = a.members[i - 1];
      if (prev !== undefined && compareIds(prev, m) >= 0) {
        out.push(`${id} members are not strictly sorted at ${m}`);
      }
      const player = lookup(r.state.players, m);
      if (player === undefined) out.push(`${id} member ${m} is not a player`);
      else if (player.alliance !== id) {
        out.push(`${id} lists ${m}, whose alliance is ${String(player.alliance)}`);
      }
    });
  }
  for (const p of sortedIds(r.state.players)) {
    const id = r.state.players[p]?.alliance ?? null;
    if (id === null) continue;
    const a = lookup(r.state.alliances, id);
    if (a === undefined) out.push(`${p} is in ${id}, which does not exist`);
    else if (!a.members.includes(p)) out.push(`${p} is in ${id}, which does not list it`);
  }
  return out;
}

function checkPacts(r: ReadCtx): string[] {
  const out: string[] = [];
  const counts: Record<string, number> = {};
  r.state.pacts.forEach((pact, i) => {
    const key = pactKey(pact.a, pact.b);
    if (compareIds(pact.a, pact.b) >= 0) out.push(`pact ${key} is not ordered a < b`);
    const prev = r.state.pacts[i - 1];
    if (prev !== undefined && comparePacts(prev, pact) >= 0) {
      out.push(`pact ${key} is not after ${pactKey(prev.a, prev.b)} (sorted, unique)`);
    }
    for (const p of [pact.a, pact.b]) {
      if (lookup(r.state.players, p) === undefined) out.push(`pact ${key}: ${p} is not a player`);
      counts[p] = (counts[p] ?? 0) + 1;
    }
    const a = lookup(r.state.players, pact.a)?.alliance ?? null;
    const b = lookup(r.state.players, pact.b)?.alliance ?? null;
    if (a !== null && a === b) out.push(`pact ${key} is between allies (${a})`);
  });
  const max = r.rules.diplomacy.maxPacts;
  for (const p of sortedIds(counts)) {
    if ((counts[p] ?? 0) > max) out.push(`${p} holds ${counts[p]} pacts, above ${max}`);
  }
  return out;
}

function checkProposals(r: ReadCtx): string[] {
  const out: string[] = [];
  const open: Record<string, number> = {};
  const seen: Record<string, ProposalId> = {};
  for (const id of sortedIds(r.state.proposals)) {
    const p = r.state.proposals[id];
    if (p === undefined) continue;
    if (p.from === p.to) out.push(`proposal ${id} is from ${p.from} to itself`);
    open[p.from] = (open[p.from] ?? 0) + 1;
    const key = `${p.from}|${p.to}|${p.kind}`;
    const dup = seen[key];
    if (dup !== undefined) out.push(`proposals ${dup} and ${id} share (from, to, kind) ${key}`);
    seen[key] = id;
  }
  const max = r.rules.diplomacy.maxOpenProposals;
  for (const p of sortedIds(open)) {
    if ((open[p] ?? 0) > max) out.push(`${p} has ${open[p]} open proposals, above ${max}`);
  }
  return out;
}

/** Runs `check` only while the ruleset keeps the default diplomacy handlers. */
function whileDefault(check: (r: ReadCtx) => string[]): (r: ReadCtx) => readonly string[] {
  return (r) => (keepsDefaultDiplomacy(r) ? check(r) : []);
}

/**
 * The diplomacy invariants of §13.3, active only while the ruleset keeps the default `propose`,
 * `answer` and `leave`: alliance membership symmetric with `player.alliance`, 2..`allianceMax`
 * sorted members; pacts sorted, unique, between non-allies, at most `maxPacts` per player; open
 * proposals within `maxOpenProposals`, one per (from, to, kind).
 */
export const diplomacyInvariants: readonly Invariant[] = Object.freeze([
  Object.freeze({ name: "domain.alliances", level: "step", check: whileDefault(checkAlliances) }),
  Object.freeze({ name: "domain.pacts", level: "step", check: whileDefault(checkPacts) }),
  Object.freeze({ name: "domain.proposals", level: "step", check: whileDefault(checkProposals) }),
]);
