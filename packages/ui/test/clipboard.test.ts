import { test } from "node:test";
import assert from "node:assert/strict";
import { copyText } from "../src/clipboard.ts";

test("legacy clipboard failure rejects so Settings cannot report a false copy success", async () => {
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, "document");
  let removed = false;
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: {} });
  Object.defineProperty(globalThis, "document", { configurable: true, value: {
    createElement: () => ({ style: {}, focus() {}, select() {} }),
    body: { appendChild() {}, removeChild() { removed = true; } },
    execCommand: () => false,
  } });
  try {
    await assert.rejects(() => copyText("Client (Web): 2.3.4"), /copy/i);
    assert.equal(removed, true);
  } finally {
    if (navigatorDescriptor) Object.defineProperty(globalThis, "navigator", navigatorDescriptor);
    else Reflect.deleteProperty(globalThis, "navigator");
    if (documentDescriptor) Object.defineProperty(globalThis, "document", documentDescriptor);
    else Reflect.deleteProperty(globalThis, "document");
  }
});
