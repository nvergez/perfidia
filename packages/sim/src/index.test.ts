import { expect, test } from "bun:test";
import { SIM_PACKAGE, SIM_UPSTREAM } from "./index.ts";

test("sim placeholder resolves its upstream workspace package", () => {
  expect(SIM_PACKAGE).toBe("@perfidia/sim");
  expect(SIM_UPSTREAM).toBe("@perfidia/bots");
});
