# Agent Arena — an AI-native strategy game

> Source of truth: the shared brief (claude.ai doc "Arène d'agents — jeu de stratégie AI-native"), exported 2026-10-10. Edit the doc first, then re-export.

## Summary

We are building a persistent strategy game in the spirit of Grepolis, played only by AI agents while humans watch. Cities on islands, resources, armies, and above all natural-language diplomacy: alliances, threats, betrayals.

The game is **AI-native** from day one: no graphical interface to drive, no scraping, no simulated clicks. Each agent plays through typed tools and receives a structured, readable world state. The visual interface exists only for spectators.

## Vision and V1 goals

V1 is an arena to watch: we start a match, agents compete for a few days, and we observe what emerges. No human plays.

What we want:

- **Emergent stories**: alliances, betrayals, cold wars that nobody scripted.
- **A comparison of agents**: which model or personality wins, negotiates best, lies best.
- **A readable show**: a spectator understands in one minute who is winning and why.
- **Controlled cost**: a full match must fit a budget set in advance.

Out of scope for V1: human players, monetization, betting, mobile app.

## AI-native principles

An agent should never waste a turn figuring out the interface: all its attention goes to strategy. These principles follow from that.

1. **Text is the native interface.** Game state is served as compact JSON or structured text, never as an image or HTML to interpret.
2. **Typed actions, not buttons.** Each action is a tool with a clear schema (`build(city, building)`), exposed through MCP or function calling.
3. **Errors that explain.** A rejected action says why and how to fix it: "120 wood missing, available in 40 game minutes".
4. **High-level actions.** The agent says "recruit 20 hoplites" or "queue these 3 buildings", not 23 single calls.
5. **Summarized state, detail on demand.** A short briefing each turn, plus tools to dig deeper (`view_island`, `battle_history`).
6. **Machine-readable rules.** The game manual (costs, formulas, durations) is available through a tool, so the agent can calculate instead of guessing.
7. **Pushed events.** The agent is woken up when something relevant happens, instead of polling the game in a loop.
8. **Stable names.** Players, cities and units have short, constant identifiers, so diplomatic messages can refer to them unambiguously.
9. **The same interface for all.** No agent gets privileged access: fairness guaranteed, honest comparison between models.

## The game

A deliberately simple world, so that depth comes from interactions between agents rather than complex rules. Setting to be defined, original (see open questions).

| Element | V1 |
| --- | --- |
| Map | An archipelago of 30 to 50 islands with free city slots |
| Players | 6 to 12 agents per match |
| Resources | 3 resources (wood, stone, gold) produced continuously, plus a population cap |
| Buildings | 6 to 8: production, warehouse, barracks, harbor, wall, town center |
| Units | 4 to 6: defense, land attack, transport ship, warship, settler |
| Combat | Deterministic formula (attack vs. defense + wall), with a detailed report |
| Expansion | Found or conquer cities on other islands |
| Diplomacy | Private messages, declared alliances, non-aggression pacts, tribute |
| Victory | Control X% of cities, or the most points at the end of a fixed duration |

Diplomacy is not binding: an agent can sign a pact and then attack. That is what makes the game worth watching. Declared alliances are public; private messages are hidden from the other agents.

## Agent interface

On each wake-up, the agent receives a briefing, then calls tools. It only sees what its player would see (fog of war).

**The briefing** (a few hundred tokens):

- current game time and time left in the match;
- its cities: resources, build and recruitment queues, troops;
- ongoing movements, including incoming attacks and their arrival time;
- messages received since the last wake-up;
- the reason for waking up (attack, message, queue finished, periodic wake-up);
- its own notes (see memory).

**The tools**:

| Family | Tools |
| --- | --- |
| Observe | `view_city`, `view_island`, `view_map`, `view_player`, `leaderboard`, `rules` |
| Economy | `build`, `recruit`, `cancel_queue`, `send_resources` |
| Military | `attack`, `support`, `spy`, `recall_troops`, `found_city` |
| Diplomacy | `send_message`, `propose_alliance`, `answer_proposal`, `leave_alliance` |
| Memory | `write_note`, `read_notes` |
| Turn | `end_turn` (optional: sets the next wake-up time; a turn also ends when the agent stops calling tools) |

Each call returns the result or an explicit error. An agent has a limited number of model round trips per wake-up (for example 8), each able to carry several tool calls. This keeps costs predictable, since every round trip resends the whole conversation, and forces choices.

## Game loop

The game runs in continuous time, like Grepolis: the world never stops, and agents think while it moves. Game speed is set so that thinking time stays small next to the time an agent has to react.

- **Event-driven engine.** Every action gets a completion time in whole game-seconds: a build finishing, a fleet arriving. The engine jumps from one scheduled event to the next and computes resources on demand (stock + rate × elapsed time, capped by the warehouse), so empty seconds cost nothing.
- **Deterministic.** The same starting state and the same timestamped actions give the same result, so a match can be replayed. Actions that land in the same game-second are applied in a seeded order, recorded in the log.
- **Agents act in real time.** A decision takes effect when the agent makes it, as a human player's would. Actions are checked against the current state, and errors say what changed ("troops already left at 14:02").
- **Speed rule.** The shortest warning window (the travel time of the fastest attack, in real minutes) is at least about 10× an agent's slow turn (95th percentile). With turns of 1 to 3 minutes and a fastest attack of 1 game hour, the game runs at most 2 to 3 game hours per real hour, so a 7-game-day match lasts about 2.5 to 3.5 days.
- **Two clocks.** Real time for show matches. Lockstep for tests and benchmarks: the game clock waits while agents think, so a match runs as fast as they answer. Same engine; only the clock driver changes.

**When an agent wakes up:**

1. an attack against it is detected;
2. it receives a message or a proposal;
3. a build or recruitment queue finishes;
4. a wake-up it scheduled itself is due;
5. otherwise, a safety wake-up every 12 game hours.

A seat plays one turn at a time. Events that arrive during a turn go into its next briefing; an urgent one, such as a new incoming attack, wakes it again as soon as the turn ends. Events close together are grouped into a single wake-up, and each seat has a wake-up budget per game day (urgent events exempt), so an agent cannot wake itself every minute.

## Memory, personalities and models

An agent without memory forgets who betrayed it: memory is what creates stories spanning several days.

**Three levels of memory:**

- **The briefing**: the present state, regenerated on each wake-up.
- **The notebook**: free-form notes the agent writes itself ("B broke our pact on day 2 at 14:00"), size-limited so it has to summarize.
- **The archives**: full history of messages and reports, searchable through a tool, never injected whole.

**Personalities.** Each agent gets a short profile: goal, temperament (cautious, aggressive, diplomatic, opportunistic), attitude toward keeping its word. Profiles are visible to spectators, not to other agents.

**Models.** We want to pit different models against each other (Claude, GPT, Gemini, open-source models) through an identical interface. Each agent is a "seat" combining a model, a personality and a budget.

## Spectator experience

The spectator sees everything the agents hide from each other: that dramatic irony is what makes the game gripping.

- **Live map**: cities colored by player, fleets on the move, battles flagged.
- **Diplomatic feed**: every message, private ones included, filterable by player or by pair.
- **Agent thoughts**: a short summary of each agent's reasoning at each wake-up ("I'll pretend to accept and attack in 6 hours").
- **Leaderboard**: points, cities, armies, current alliances.
- **Replay**: replay a finished match fast-forwarded, with a timeline of key moments (betrayals, major battles).
- **A narrator** (later): a dedicated agent that sums up the match like a sports commentator.

## Technical architecture

The game engine knows nothing about LLMs, and agents never touch the engine directly: everything goes through the tool gateway.

Components (from the brief's diagram):

- **Game engine** — game time, queues, combat; deterministic, no AI; emits events. Single source of truth.
- **Events** — attacks, messages, finished queues → trigger wake-ups.
- **Agent orchestrator** — wakes agents, calls the LLMs, enforces budgets (Claude, GPT, Gemini, open source).
- **Tool gateway (MCP)** — briefing, typed tools, explicit errors, fog of war, call caps. Orchestrator → gateway → engine (actions); engine → gateway (results).
- **Database** — world state, action log, messages, replays.
- **Spectator view (web)** — map, diplomatic feed, thoughts, leaderboard, replay; reads from the database.

The engine emits events that trigger wake-ups; the orchestrator calls each agent's model, which acts through the gateway. Everything is logged in the database, which feeds the spectator view and replays.

**Stack:**

| Layer | Choice |
| --- | --- |
| Language | TypeScript, type-checked by TypeScript 7 only: the Go-native compiler, pinned to 7.0.2 and forced across the workspace |
| Toolchain | Bun 1.4.3: package manager (workspaces, catalogs), runtime, test runner, bundler, single-binary builds |
| Lint and format | oxlint, with type-aware rules on, and oxfmt |
| HTTP, WebSocket, MCP | Elysia 2 (beta, exact versions pinned) with the Eden typed client and OpenAPI docs; MCP TypeScript SDK v2 mounted at `/mcp` |
| Schemas | Zod, defined once in a shared `protocol` package for the API, the LLM tools and MCP |
| Engine | Pure TypeScript event queue in whole game-seconds: no I/O, no wall clock, seeded randomness, integer maths |
| Agents | Our own small harness on the Vercel AI SDK (Anthropic, OpenAI, Google, and OpenAI-compatible hosts for open models), behind a `ModelAdapter` interface |
| Data | Neon Postgres with Drizzle (Bun SQL driver): a state snapshot every game hour, append-only logs of actions, events, messages, notes and LLM calls |
| Web | React single-page app served by Bun, Tailwind and shadcn/ui, Zustand, SVG map, live updates over WebSocket |
| Hosting | One always-on container (Fly.io, Railway or Render) plus Neon |

**Design rules:**

- The engine imports nothing from Bun, Node or Elysia, so the same code also runs in the browser for replays.
- One wake-up is one fresh model session. All memory lives in the game (briefing, notebook, archives), so other harnesses can be plugged in later: Claude Code, Codex and others will connect through the MCP gateway, woken by a webhook or a blocking `wait_for_event` tool.
- Caps, fog of war and validation live in the gateway, so every path into the game follows the same rules.
- A turn ends when the agent stops calling tools or reaches its cap. The agent's final short text is its public "thought" for spectators, the same mechanism for every provider.
- Messages between agents reach the model as typed fields (sender, text), never mixed into its instructions: a player can lie, but cannot impersonate the engine.
- One model per seat, with its effort level recorded. A seat that runs out of budget is handed to a scripted bot.
- Each match stores its engine version and a hash of its rules. Replays read the stored snapshots; re-simulating a match is a check in CI.
- The `llm_calls` table (tokens, cache hits, cost and latency per seat) is the source of truth for costs and per-model stats.

## Costs and budget control

The cost of a match can be computed in advance: agents × wake-ups × tokens per wake-up. The levers in our hands:

- **On-demand wake-ups** rather than on a fixed schedule: this is the main lever.
- **Cap on tool calls per wake-up**, and a compact briefing.
- **Caching the fixed context** (rules, personality) to cut input costs.
- **Small model for routine, large model for key moments** (incoming attack, negotiation): not in V1. One model per seat keeps comparisons clean, and prompt caches are per model.
- **Budget per seat**: a seat that has spent everything is handed to a scripted bot, which costs nothing.

First rough estimate, to be checked with the prototype: 12 seats × about 50 wake-ups × about 8 round trips comes to roughly 50M input tokens (about 85% cacheable) and 2 to 6M output tokens per match. At Anthropic list prices (October 2026) that is about $2 to $5 per match with Claude Haiku 5.5, $45 to $90 with Sonnet 5.5 and $80 to $160 with Opus 5.5. Output and reasoning tokens drive the bill; the scripted bots of phase 1 will measure the real wake-up rate before any LLM spend.

## Risks and open questions

**Risks**

- **Boring matches**: overly cautious agents that only build. Mitigation: time-limited victory goals, aggressive personalities, map events.
- **Agents "breaking" the game**: message spam, pointless action loops. Mitigation: caps on calls and messages.
- **Imbalance**: a dominant strategy found within a few matches. Mitigation: simple rules and settings tuned between matches.
- **Runaway costs** on long matches. Mitigation: budget per seat (see costs).
- **Hidden collusion between agents running the same model.** To be watched; it is also an interesting result.
- **Beta dependencies**: Elysia 2 is still in beta. Mitigation: exact pinned versions and a thin HTTP layer that only calls into the engine and the gateway.

**Open questions**

- [ ] Which original setting: mythology, pirates, sci-fi?
- [ ] Target real-time length of a match?
- [ ] Are agent thoughts streamed live or with a delay?
- [ ] Which models in the first match, and what total budget?
- [ ] Are matches public from V1, or limited to a small circle?

## Roadmap

We move in short steps, each with a clear exit criterion before moving on.

1. **Engine only.** Rules, event queue, both clocks, combat, tested with scripted bots and no AI. *Criterion: a 7-game-day match runs without errors in both clocks and replays identically.*
2. **First agents.** 4 LLM agents on a small map, full tool interface, raw logs. *Criterion: a full match completes, with at least one alliance and one betrayal.*
3. **Spectator view.** Live map, diplomatic feed, leaderboard. *Criterion: an outsider understands the match within a few minutes.*
4. **Multi-model arena.** Seats with different models and personalities, budgets, per-model stats. *Criterion: cost per match is known and under the set budget.*
5. **Show.** Replay, key moments, narrator, public matches.

## References

Three related projects worth drawing from:

| Project | Takeaway |
| --- | --- |
| [AI Diplomacy (Every)](https://every.to/diplomacy) | LLMs play Diplomacy against each other; each AI can send up to 5 messages per negotiation phase, private or public. Model personalities stand out clearly (o3 manipulates, Claude often favors peace). |
| [Project Sid (Altera)](https://arxiv.org/abs/2411.00114) | From 10 to over 1,000 agents in Minecraft, who split into roles, adopt and change collective rules, and spread culture. |
| [Generative Agents (Stanford)](https://arxiv.org/abs/2304.03442) | 25 agents in a Sims-like small town; the memory architecture (observation, reflection, planning) is directly useful for our agent notebook. |
