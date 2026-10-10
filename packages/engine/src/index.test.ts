import { expect, test } from "bun:test";
import { ENGINE_PACKAGE, ENGINE_UPSTREAM } from "./index.ts";

test("engine placeholder resolves its upstream workspace package", () => {
  expect(ENGINE_PACKAGE).toBe("@perfidia/engine");
  expect(ENGINE_UPSTREAM).toBe("@perfidia/protocol");
});
