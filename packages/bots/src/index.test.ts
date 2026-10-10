import { expect, test } from "bun:test";
import { BOTS_PACKAGE, BOTS_UPSTREAM } from "./index.ts";

test("bots placeholder resolves its upstream workspace package", () => {
  expect(BOTS_PACKAGE).toBe("@perfidia/bots");
  expect(BOTS_UPSTREAM).toBe("@perfidia/gateway");
});
