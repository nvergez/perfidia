// The bots registry keeps every version a committed golden names (docs/architecture.md §11.1,
// §13.5): every `bot:` label of every golden under `fixtures/golden/**` (header controllers and
// `controller` hand-off lines) parses and builds exactly that version, so a new bot version cannot
// silently drop an old golden to Level E only. The re-simulation itself runs in `src/golden.test.ts`.

import { expect, test } from "bun:test";
import { botFromLabel, botLabel, parseBotLabel } from "@perfidia/bots";
import { DEFAULT_BOTS, listGoldens, resimProblem } from "../harness/index.ts";
import { readLog } from "../io/index.ts";
import { FIXTURES_DIR } from "./index.ts";

test("every bot label of every committed golden is a bot of this build", () => {
  const goldens = listGoldens(FIXTURES_DIR);
  expect(goldens.length).toBeGreaterThan(0);
  const seen = new Set<string>();
  const problems: string[] = [];
  let botGoldens = 0;
  for (const g of goldens) {
    const lines = readLog(g.path);
    const header = lines[0];
    if (header?.k !== "header") {
      problems.push(`${g.ref}/${g.name}: no header line`);
      continue;
    }
    const labels = [
      ...Object.values(header.controllers),
      ...lines.flatMap((l) => (l.k === "controller" ? [l.label] : [])),
    ];
    const bots = labels.filter((l) => l.startsWith("bot:"));
    for (const label of bots) {
      seen.add(label);
      const parsed = parseBotLabel(label);
      const built = botFromLabel(label, { seat: "p1", seed: 1 });
      if (parsed === null || built?.label !== label) {
        problems.push(`${g.ref}/${g.name}: ${label} is not a bot of this build`);
      }
    }
    if (bots.length === labels.length) {
      botGoldens += 1;
      const why = resimProblem(header, lines);
      if (why !== null) problems.push(`${g.ref}/${g.name}: ${why}`);
    }
  }
  expect(problems).toEqual([]);
  // Not vacuous: the bot goldens of §13.5 are there, with the phase-1 labels, the PR #7 ones
  // (rusher@2, conqueror@1), the PR #8 ones (rusher@3 and the @2 versions), the war-call bots
  // (the @3 versions) and the latest version of every default bot.
  expect(botGoldens).toBeGreaterThanOrEqual(20);
  for (const label of [
    "bot:expander@1",
    "bot:rusher@1",
    "bot:rusher@2",
    "bot:turtle@1",
    "bot:opportunist@1",
    "bot:conqueror@1",
    "bot:expander@2",
    "bot:rusher@3",
    "bot:turtle@2",
    "bot:opportunist@2",
    "bot:conqueror@2",
    "bot:turtle@3",
    "bot:opportunist@3",
    "bot:conqueror@3",
  ]) {
    expect(seen.has(label)).toBe(true);
  }
  for (const s of DEFAULT_BOTS) expect(seen.has(botLabel(s))).toBe(true);
});
