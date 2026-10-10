import { expect, test } from "bun:test";
import { GATEWAY_PACKAGE, GATEWAY_UPSTREAM } from "./index.ts";

test("gateway placeholder resolves its upstream workspace package", () => {
  expect(GATEWAY_PACKAGE).toBe("@perfidia/gateway");
  expect(GATEWAY_UPSTREAM).toBe("@perfidia/engine");
});
