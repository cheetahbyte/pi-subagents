import { describe, expect, it } from "vitest";
import { addUsage, getLifetimeCost, getLifetimeTotal, getSessionContextPercent, PendingUsagePool } from "../src/usage.js";

// Regression for issue #38 — token semantics + context indicator
describe("usage", () => {
  describe("getSessionContextPercent", () => {
    it("returns null when contextUsage is unavailable", () => {
      expect(getSessionContextPercent({ getContextUsage: () => undefined })).toBeNull();
    });

    it("returns null when percent is null (post-compaction)", () => {
      const session = {
        getContextUsage: () => ({ tokens: null, contextWindow: 200_000, percent: null }),
      };
      expect(getSessionContextPercent(session)).toBeNull();
    });

    it("returns the upstream percent when available", () => {
      const session = {
        getContextUsage: () => ({ tokens: 50_000, contextWindow: 200_000, percent: 25 }),
      };
      expect(getSessionContextPercent(session)).toBe(25);
    });
  });

  describe("getLifetimeTotal", () => {
    it("sums components and handles undefined", () => {
      expect(getLifetimeTotal(undefined)).toBe(0);
      expect(getLifetimeTotal({ input: 100, output: 200, cacheWrite: 50 })).toBe(350);
    });

    // The accumulator survives compaction because it lives on AgentActivity /
    // AgentRecord, not on session.state.messages (which compaction replaces).
    it("stays monotone across simulated compaction when fed via addUsage-style accumulation", () => {
      const usage = { input: 0, output: 0, cacheWrite: 0 };
      const onUsage = (u: { input: number; output: number; cacheWrite: number }) => {
        usage.input += u.input;
        usage.output += u.output;
        usage.cacheWrite += u.cacheWrite;
      };

      // 5 normal turns
      for (let i = 0; i < 5; i++) onUsage({ input: 1000, output: 200, cacheWrite: 50 });
      expect(getLifetimeTotal(usage)).toBe(5 * 1250);

      // Compaction would replace session.state.messages, dropping any sum
      // re-derived from it. Our accumulator is independent — no reset.
      const beforeCompaction = getLifetimeTotal(usage);

      // 3 more turns post-"compaction"
      for (let i = 0; i < 3; i++) onUsage({ input: 800, output: 150, cacheWrite: 30 });
      expect(getLifetimeTotal(usage)).toBe(beforeCompaction + 3 * 980);
      expect(getLifetimeTotal(usage)).toBeGreaterThan(beforeCompaction); // monotone

      // input + output + cacheWrite = total — by construction, no drift
      expect(usage.input + usage.output + usage.cacheWrite).toBe(getLifetimeTotal(usage));
    });
  });

  describe("cost accumulation", () => {
    it("sums cost across messages but keeps it out of the token total", () => {
      const usage = { input: 0, output: 0, cacheWrite: 0 };
      addUsage(usage, { input: 100, output: 50, cacheWrite: 10, cacheRead: 900, cost: 0.002 });
      addUsage(usage, { input: 200, output: 80, cacheWrite: 20, cacheRead: 1800, cost: 0.004 });

      expect(getLifetimeCost(usage)).toBeCloseTo(0.006, 10);
      // The load-bearing half: the display total takes neither the money nor
      // the re-read prefix, even though both are accumulated on the same object.
      expect(getLifetimeTotal(usage)).toBe(460);
      expect(usage.cacheRead).toBe(2700);
    });

    it("leaves cost absent when nothing priced anything", () => {
      // An unpriced model reports 0 per message. Distinguishable from "counted
      // and free" only by the field never being written at all.
      const usage: { input: number; output: number; cacheWrite: number; cost?: number } =
        { input: 0, output: 0, cacheWrite: 0 };
      addUsage(usage, { input: 10, output: 5, cacheWrite: 0, cost: 0 });

      expect(usage.cost).toBeUndefined();
      expect(getLifetimeCost(usage)).toBe(0);
    });

    it("reads a missing cost as 0", () => {
      expect(getLifetimeCost(undefined)).toBe(0);
      expect(getLifetimeCost({ input: 1, output: 1, cacheWrite: 0 })).toBe(0);
    });
  });

  describe("PendingUsagePool", () => {
    it("drains what it accumulated as a complete pi Usage", () => {
      const pool = new PendingUsagePool();
      pool.add({ input: 100, output: 50, cacheWrite: 10, cacheRead: 900, cost: 0.01 });
      pool.add({ input: 200, output: 80, cacheWrite: 20, cacheRead: 1800, cost: 0.02 });

      expect(pool.drain()).toEqual({
        input: 300,
        output: 130,
        // Summed, unlike the display total (#38): pi counts the parent's own
        // messages this way, and the prefix is re-billed on every call.
        cacheRead: 2700,
        cacheWrite: 30,
        totalTokens: 3160,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.03 },
      });
    });

    it("empties on drain, so no message is reported twice", () => {
      const pool = new PendingUsagePool();
      pool.add({ input: 100, output: 50, cacheWrite: 10, cost: 0.01 });

      expect(pool.drain()?.totalTokens).toBe(160);
      expect(pool.drain()).toBeUndefined();
    });

    it("handles an accumulator that never saw a cacheRead or a cost", () => {
      // Both fields are optional and written lazily, so an agent on a provider
      // that reports neither leaves them absent rather than zero.
      const pool = new PendingUsagePool();
      pool.add({ input: 100, output: 50, cacheWrite: 10 });

      expect(pool.drain()).toEqual({
        input: 100, output: 50, cacheRead: 0, cacheWrite: 10, totalTokens: 160,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      });
    });

    it("returns undefined when nothing has been added", () => {
      expect(new PendingUsagePool().drain()).toBeUndefined();
    });

    it("still reports tokens spent by a model with no pricing", () => {
      const pool = new PendingUsagePool();
      pool.add({ input: 100, output: 50, cacheWrite: 10, cost: 0 });

      const drained = pool.drain();
      expect(drained?.totalTokens).toBe(160);
      expect(drained?.cost.total).toBe(0);
    });

    it("reports nothing for a message that spent nothing", () => {
      const pool = new PendingUsagePool();
      pool.add({ input: 0, output: 0, cacheWrite: 0, cost: 0 });

      expect(pool.drain()).toBeUndefined();
    });
  });
});
