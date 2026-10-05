/**
 * workflow-call-name.test.ts — the call line's name cache holds one source.
 *
 * pi calls `renderCall` with partial arguments on every streaming update, so a
 * cache keyed by source would keep every prefix of every inline script for the
 * life of the session. The cache is private, so what is asserted is the one
 * thing a bounded cache does differently: an older source is parsed again.
 */

import type * as Vm from "node:vm";
import { describe, expect, it, vi } from "vitest";

const parses = vi.hoisted(() => ({ count: 0 }));

vi.mock("node:vm", async importOriginal => {
  const actual = await importOriginal<typeof Vm>();
  class CountingScript extends actual.Script {
    constructor(...args: ConstructorParameters<typeof actual.Script>) {
      super(...args);
      parses.count++;
    }
  }
  return { ...actual, Script: CountingScript };
});

import { workflowCallName } from "../src/workflow/meta.ts";

const script = (name: string) => `export const meta = { name: "${name}", description: "d" };\nreturn 1;`;

describe("workflowCallName", () => {
  it("remembers only the most recent source", () => {
    expect(workflowCallName({ script: script("first") })).toBe("first");
    expect(workflowCallName({ script: script("first") })).toBe("first");
    expect(parses.count).toBe(1);

    expect(workflowCallName({ script: script("second") })).toBe("second");
    expect(workflowCallName({ script: script("first") })).toBe("first");
    expect(parses.count).toBe(3);
  });
});
