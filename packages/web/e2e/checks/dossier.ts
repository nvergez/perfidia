// Pass C checks of the dossier extras (C2): agent D's file (docs/phase3.md §16.4). Registered
// inside the smoke test's `describe` by `smoke.test.ts`; the environment, `open` and the DOM checks
// come from `../kit.ts`. Step C0 checks the wiring only: the dossier sheet (a chunk loaded on
// demand) opens from the leaderboard for the right seat with its counts.

import { expect, test } from "bun:test";
import { domIsClean, mapReady, open } from "../kit.ts";

export function dossierChecks(): void {
  test("C2: the dossier opens from the leaderboard with its counts", async () => {
    const page = await open("/m/fake1");
    await mapReady(page);
    await page.locator("[data-testid=leaderboard] [data-player=p2] button").first().click();
    const sheet = page.getByTestId("player-sheet");
    await sheet.waitFor();
    await sheet.getByText(/· p2/).first().waitFor();
    expect((await sheet.textContent()) ?? "").toMatch(/\d+ turns?/);
    await domIsClean(page);
  }, 20_000);
}
