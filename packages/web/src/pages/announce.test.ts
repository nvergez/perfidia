import { describe, expect, test } from "bun:test";
import { ANNOUNCE_EVERY_MS, announce, type AnnounceInput, type AnnounceState } from "./announce.ts";

const m = (seq: number) => ({ seq, title: `moment ${seq}` });
const input = (o: Partial<AnnounceInput>): AnnounceInput => ({
  newest: null,
  ready: true,
  quiet: false,
  now: 100_000,
  ...o,
});

/** Runs inputs through `announce`, collecting what is said. */
function run(inputs: readonly AnnounceInput[]): { said: string[]; state: AnnounceState | null } {
  let state: AnnounceState | null = null;
  const said: string[] = [];
  for (const i of inputs) {
    const r = announce(state, i);
    state = r.state;
    if (r.action.kind === "say") said.push(r.action.text);
  }
  return { said, state };
}

describe("the moments' live region", () => {
  test("what is past when the match has loaded is not news, even if moments arrive late", () => {
    // Loading: nothing is decided; then ready at the end with the end moment past.
    expect(run([input({ ready: false }), input({ newest: m(90) })]).said).toEqual([]);
    expect(run([input({ ready: false, newest: m(90) }), input({ newest: m(90) })]).said).toEqual(
      [],
    );
  });

  test("a moment the playhead passes is said; one inside the window waits for it, then the newest is said", () => {
    const r1 = announce(null, input({ newest: m(1), now: 0 }));
    const r2 = announce(r1.state, input({ newest: m(5), now: 1_000 }));
    expect(r2.action).toEqual({ kind: "say", text: "moment 5" });
    const r3 = announce(r2.state, input({ newest: m(8), now: 2_000 }));
    expect(r3.action).toEqual({ kind: "later", ms: ANNOUNCE_EVERY_MS - 1_000 });
    const r4 = announce(r3.state, input({ newest: m(9), now: 1_000 + ANNOUNCE_EVERY_MS }));
    expect(r4.action).toEqual({ kind: "say", text: "moment 9" });
  });

  test("a seek backwards says nothing, and moving forward again is news", () => {
    const { said } = run([
      input({ newest: m(50), now: 0 }),
      input({ newest: m(10), now: 10_000 }),
      input({ newest: m(50), now: 20_000 }),
    ]);
    expect(said).toEqual(["moment 50"]);
  });

  test("while the reel runs, moments pass silently", () => {
    const { said } = run([
      input({ newest: null, now: 0 }),
      input({ newest: m(3), quiet: true, now: 10_000 }),
      input({ newest: m(3), now: 20_000 }),
      input({ newest: m(7), now: 30_000 }),
    ]);
    expect(said).toEqual(["moment 7"]);
  });
});
