// The sim harness (docs/architecture.md §12.1): shared by the CLI, the integration test, the
// hardening, golden and exit tests, so `verify --resim` and the golden tests cannot drift apart.
// Time sources, bot runs and Level G options from a log header, normalised logs, the canonical
// JSONL writer, the log reader, the golden check and add-only writers, and the ruleset fingerprint.

export { SystemTime, createVirtualTime, systemWall, yieldMacrotask } from "./time.ts";
export { JsonlFileSink, jsonlText, parseJsonl, snapshotFileName, writeJsonl } from "./jsonl.ts";
export {
  JsonlError,
  LogFileError,
  isCorruptLog,
  isGzip,
  parseLogLine,
  readFirstLine,
  readLog,
  readLogLines,
} from "./reader.ts";
export { normaliseLog, normalisedHash, normalisedText } from "./normalise.ts";
export {
  DEFAULT_BOTS,
  DEFAULT_LATENCY_MS,
  agentFromLabel,
  botAgents,
  optionsFromHeader,
  prepareBotRun,
  resimProblem,
  resimulate,
  runBots,
  runPrepared,
  setupFor,
  type BotRun,
  type BotRunSpec,
  type ClockChoice,
  type PreparedRun,
  type SetupSpec,
  type ThinkTime,
} from "./match.ts";
export {
  ViewHasher,
  checkpointView,
  rulesetArtefacts,
  rulesetFingerprint,
  type RulesetArtefacts,
} from "./fingerprint.ts";
export {
  FINGERPRINTS_FILE,
  FingerprintEntrySchema,
  FingerprintsSchema,
  GOLDEN_DIR,
  GZIP_ABOVE_BYTES,
  GoldenExists,
  addFingerprints,
  appendOnlyProblems,
  addGolden,
  checkGoldens,
  goldenPath,
  listGoldens,
  readFingerprints,
  type FingerprintEntry,
  type Fingerprints,
  type GoldenCheck,
  type GoldenFile,
  type GoldenReport,
} from "./golden.ts";
