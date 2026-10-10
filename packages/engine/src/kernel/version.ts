/**
 * The engine version (semver), recorded in every log header and snapshot envelope but never in the
 * hashed state (docs/architecture.md §1, §3.5). Replay warns on a mismatch and proceeds; the hashes
 * decide. A bump never permits rewriting a golden or a fingerprint.
 */
export const ENGINE_VERSION = "0.1.0";
