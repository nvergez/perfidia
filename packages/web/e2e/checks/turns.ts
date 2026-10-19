// Pass C checks of the turn detail (C1) and the live reasoning (C3): agent T's file
// (docs/phase3.md §16.4). Registered inside the smoke test's `describe` by `smoke.test.ts`; the
// environment, `open` and the DOM checks come from `../kit.ts`. Step C0 checks the wiring only:
// "Turn detail" opens the sheet (a chunk loaded on demand) for the right turn, and Escape closes
// it with the focus back on the button.

import { expect, test } from "bun:test";
import { domIsClean, focused, mapReady, open } from "../kit.ts";

export function turnChecks(): void {
  test("C1: “Turn detail” opens the turn's sheet; Escape closes it, the focus returns", async () => {
    const page = await open("/m/fake1");
    await mapReady(page);
    await page.getByRole("tab", { name: "Thoughts" }).click();
    const thoughts = page.getByTestId("thoughts");
    const button = thoughts.locator("[data-open-turn]").first();
    const which = (await button.getAttribute("data-open-turn")) ?? "";
    const [seat = "", turn = ""] = which.split(":");
    await button.click();
    const sheet = page.getByTestId("turn-sheet");
    await sheet.waitFor();
    expect((await sheet.textContent()) ?? "").toContain(`${seat} · turn ${turn}`);
    await page.keyboard.press("Escape");
    await sheet.waitFor({ state: "detached" });
    expect(await focused(page)).toBe(`button[data-open-turn=${which}]`);
    await domIsClean(page);
  }, 20_000);
}
