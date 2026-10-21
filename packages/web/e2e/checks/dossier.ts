// Pass C checks of the dossier extras (C2): agent D's file (docs/phase3.md §16.4, §16.8).
// Registered inside the smoke test's `describe` by `smoke.test.ts`; the environment, `open` and the
// DOM checks come from `../kit.ts`. On the finished fake run, p2's dossier (a chunk loaded on
// demand, opened from the leaderboard) shows its record equal to the server's counts, its score
// and cities hour by hour up to the end line, and every version of its notebook with a diff; then,
// with the playhead moved back to D1 06:00, only what had happened by then, and its model block
// (phase 4 Pass 3) no whole-match figure until the viewer asks for them.

import { expect, test } from "bun:test";
import { PlayerDossierSchema, type PlayerDossier } from "@perfidia/protocol/spectator";
import { HOUR, current, domIsClean, focused, mapReady, open, seekWithKeys } from "../kit.ts";

const n = (v: number): string => v.toLocaleString("en-US");
const versions = (v: number): string => `${n(v)} ${v === 1 ? "version" : "versions"} so far`;

/** "Turns played 27": a record tile's value. */
function tile(text: string, label: string): number {
  const m = new RegExp(`${label}([0-9,]+)`).exec(text);
  return m === null ? -1 : Number((m[1] ?? "").replaceAll(",", ""));
}

export function dossierChecks(): void {
  test("C2: the dossier's record, hour by hour and notebook history, up to the playhead", async () => {
    const res = await fetch(`${current().url}/api/matches/fake1/players/p2`);
    const d: PlayerDossier = PlayerDossierSchema.parse(await res.json());
    const page = await open("/m/fake1");
    await mapReady(page);
    const openP2 = async (): Promise<void> => {
      await page.locator("[data-testid=leaderboard] [data-player=p2] button").first().click();
      await page.getByTestId("player-sheet").getByText(/· p2/).first().waitFor();
    };
    await openP2();
    const sheet = page.getByTestId("player-sheet");
    // The sheet takes the focus itself, not the first button far down its body.
    expect(await focused(page)).toBe("div[data-testid=player-sheet]");
    // At the end of the finished run: the record equals the server's counts.
    const record = (await sheet.getByTestId("seat-record").textContent()) ?? "";
    expect([
      tile(record, "Turns played"),
      tile(record, "Messages sent"),
      tile(record, "Messages received"),
      tile(record, "Betrayals committed"),
      tile(record, "Betrayals suffered"),
    ]).toEqual([d.counts.turns, d.counts.messagesSent, d.counts.messagesReceived, 0, 0]);
    // Hour by hour, to the end line's point (D2 00:00), its value read out.
    const last = d.hourly.at(-1);
    expect(last?.t).toBe(86_400);
    const hourly = sheet.getByTestId("hourly");
    await hourly.waitFor();
    const h = (await hourly.textContent()) ?? "";
    expect(h).toContain(`Score by game hour: ${n(d.hourly[0]?.score ?? -1)} points at D1 01:00`);
    expect(h).toContain(`${n(last?.score ?? -1)} D2 00:00`);
    // Every version of the notebook, each against the one before.
    const history = sheet.getByTestId("notebook-history");
    expect((await history.textContent()) ?? "").toContain(versions(d.notebook.total));
    expect(await history.locator("[data-diff=add]").count()).toBeGreaterThan(0);
    // Back at D1 06:00: nothing after the playhead.
    await page.keyboard.press("Escape");
    await sheet.waitFor({ state: "detached" });
    await seekWithKeys(page, 6 * HOUR);
    await openP2();
    const early = (await sheet.getByTestId("hourly").textContent()) ?? "";
    expect(early).toContain("D1 06:00");
    expect(early).not.toContain("D2 00:00");
    const kept = d.notebook.versions.filter((v) => v.t <= 6 * HOUR).length;
    expect((await sheet.getByTestId("notebook-history").textContent()) ?? "").toContain(
      versions(kept),
    );
    const before = (await sheet.getByTestId("seat-record").textContent()) ?? "";
    expect(tile(before, "Turns played")).toBeLessThan(d.counts.turns);
    // The model block too (phase 4 Pass 3 review fix): who the model is, never the whole match's
    // figures, until the viewer asks for them.
    const block = sheet.getByTestId("model-block");
    await block.getByTestId("model-later").waitFor();
    const later = (await block.textContent()) ?? "";
    for (const s of ["Calls", "Incidents", "spent by every seat", "attempts:", "handed to"]) {
      expect([s, later.includes(s)]).toEqual([s, false]);
    }
    expect(later).toContain("Rehearsal");
    expect(await block.getByTestId("model-spend").count()).toBe(0);
    await block.getByRole("button", { name: "Show the whole match's figures" }).click();
    await block.getByText("Over the whole match, whatever the time shown.").waitFor();
    expect(await block.getByTestId("model-spend").count()).toBe(1);
    await domIsClean(page);
  }, 20_000);
}
