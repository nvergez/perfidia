// `sim golden` (docs/architecture.md §13.5, §13.6): the freeze guard's check and add-only update.

export {
  FIXTURES_DIR,
  GOLDEN_SPECS,
  checkFixtures,
  updateGoldens,
  type BotGoldenSpec,
  type GoldenSpec,
  type ScenarioGoldenSpec,
  type GoldenUpdate,
} from "./golden.ts";
export { GOLDEN_USAGE, goldenCommand } from "./command.ts";
