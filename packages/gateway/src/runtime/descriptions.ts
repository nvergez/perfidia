import type { ToolName } from "@perfidia/protocol";

// The descriptions of the brief's 22 tools (docs/architecture.md §8.3): agent-visible text owned by
// the gateway, identical in every ruleset. They name rule fields (`rules.gateway.selfWake`, …),
// never a ruleset's own ids or numbers, which agents read from the `rules` tool. `toolDefinitions`
// pairs them with the JSON Schema of each tool's arguments; a test pins them verbatim. Only model
// seats read them (bots never do, and no log line holds them), so a change is versioned with the
// orchestrator's PROMPT_VERSION, whose tools hash pins them, not with ENGINE_VERSION; where the
// presentations differ (`read_notes`), they describe presentation 2, the LLM seats'.

export const TOOL_DESCRIPTIONS: Readonly<Record<ToolName, string>> = Object.freeze({
  view_city:
    "View one city. Your own and allied cities in full: stock, production rates, storage cap, population, buildings, build and recruit queues with their item numbers and end times, units at home, stationed groups and the movements you can see arriving or leaving. Any other city: its public fields and the latest spy or battle report you hold about it, with its age.",
  view_island:
    "View one island: kind, coordinates, richness, slots with the cities on them and the free ones, and the travel time from each of your cities for every travel group of the rules.",
  view_map:
    "Every island and city with their public fields. With fromCity (one of your cities), also the travel time from it to every island for every travel group of the rules.",
  view_player:
    "A player's public profile: cities, score and its public parts, relations (allies and pacts) and its relation to you; the leaderboard already lists every player's score, city count and relations, so on another player this adds only its city ids. On yourself it adds your movements, your groups stationed in other cities, your founding-unit count and the next founding-unit cost, your open proposals, today's counters (today.day counts from 0: D1 is day 0) and your pending self-wake.",
  leaderboard:
    "The standings: rank, score and its public parts, cities and alive status of every player, with alliances and relations, plus the match-wide public state of the ruleset (for example running countdowns).",
  rules:
    "The rules of this match: how turns, wakes, caps, batches, times and ids work (interface), the ruleset's cheat sheet, the effective config, the compiled tables (costs, times, levels, units, queues, movement and diplomacy limits, gateway caps and wake rules) and the ruleset's extra tools. They never change during a match.",
  build:
    "Queue buildings in one of your cities, in order. Each item is its own action and succeeds or fails on its own (not atomic); the result reports each item: its queue item number, target level, cost paid and end time, or why it failed. At most the build queue's length (rules.queues.build.max) items per call.",
  recruit:
    'Recruit units in one of your cities: up to 5 orders {unit, count}, applied in order, each succeeding or failing on its own (not atomic). count "max" recruits the most possible when that order runs, after the earlier ones: limited by stock, free population, the queue and the per-order limit. Each order\'s result gives its queue item number, the count, the cost and the end time.',
  cancel_queue:
    "Cancel queue item #item of one of your cities together with every later item of the same queue. Refunds follow rules.queues.refund, capped by storage.",
  send_resources:
    "Ship wood, stone and gold from one of your cities to another city, yours or another player's. The cargo leaves your stock now and arrives after the travel time; what the destination's storage cannot hold is lost. In-flight cargo per city may be capped (rules.movement.shipment).",
  attack:
    "Send units from one of your cities to attack a city. The target and the foe you fight are fixed at launch (the result's party). Counts against your attack launches per game day. A movement can be turned back within the recall window (rules.movement.recall).",
  support:
    "Send units from one of your cities to defend another city, where they stay stationed until recalled or dismissed. The result's party is the player the support is recorded for at launch, usually the city's owner; what your units do on arrival if the city has changed hands or is besieged meanwhile follows the cheat sheet.",
  spy: "Send gold from one of your cities to spy on a city (at least rules.movement.spyMinGold). The report or the failure notice comes back when it arrives.",
  recall_troops:
    "Exactly one mode per call. {movement}: turn one of your movements back within its recall window. {stationedAt, home?, units?}: bring your units stationed in a city home: all of them, the group from one home city, or part of it, as the rules allow. {dismiss: {city, player}}: send a player's support group in your city home.",
  found_city:
    "Send units, including the founding unit of the rules (rules.roles), from one of your cities to found a new city on an island with a free slot. slot is accepted only when rules.toolOptions.foundSlot allows choosing it; otherwise the lowest free slot at arrival is used.",
  send_message:
    'Send a message to a list of players (private: only they and you see it) or to "all" (public: in everyone\'s news; it wakes nobody). Counts once against your messages per game day, whatever the recipients. Nothing written is binding.',
  propose_alliance:
    "Propose an alliance (kind alliance; name names a new alliance) or a non-aggression pact (kind pact) to a player, with an optional text. It expires after rules.diplomacy.proposalTtl and cannot be withdrawn. Limits (rules.diplomacy) are checked again when it is accepted: if one no longer allows it, the acceptance is refused and the proposal stays open until it expires. A pact proposed to a current pact partner renews that pact once accepted, for rules.diplomacy.pactDuration from the acceptance, and does not count as a new pact. until (a pact end) is accepted only when rules.toolOptions.pactUntil allows it. Nothing is binding.",
  answer_proposal:
    "Accept or refuse an open proposal addressed to you; its id is in your briefing. Limits are checked when you accept; a refused acceptance leaves the proposal open. In a proposal_answered event, the player who answered is always its to (the addressee).",
  leave_alliance:
    "Without with: leave your alliance. With a pact partner: end that pact. With an ally: leave the alliance.",
  write_note:
    "Write your notebook, which every briefing shows verbatim: mode append adds a line, mode replace rewrites it. At most rules.gateway.notesMaxChars characters.",
  read_notes:
    "Without arguments: your notebook (search and open results leave it out: every briefing shows it). search looks through your archive (scope mine), the public feed (public) or both (all, the default), filtered by case-insensitive text, event kinds, a counterpart player and a time range, newest first, at most limit hits (20 at most); when more is true, repeat the search with before set to the last hit's e to read the next page. open returns one full message or report by its id.",
  end_turn:
    "End your turn. nextWakeIn (seconds ahead) or wakeAt (a game time), at most one, sets your self-wake: it is clamped into rules.gateway.selfWake and stays pending until it fires or a later end_turn replaces it. end_turn {} keeps any pending self-wake. Calls after end_turn in the same round trip are not run, and that round trip's results are not returned: your next briefing's lastTurn lists its failures and warnings (WAKE_CLAMPED when the wake was clamped).",
});
