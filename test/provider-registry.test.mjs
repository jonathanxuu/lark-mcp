import test from "node:test";
import assert from "node:assert/strict";
import { getProvider, providers } from "../src/providers/registry.mjs";

test("registers both supported platforms", () => {
  assert.equal(getProvider("lark").id, "lark");
  assert.equal(getProvider("feishu").id, "feishu");
  assert.deepEqual(Object.keys(providers).sort(), ["feishu", "lark"]);
});

test("rejects an unsupported platform", () => {
  assert.throws(() => getProvider("unknown"), /Unsupported platform/);
});
