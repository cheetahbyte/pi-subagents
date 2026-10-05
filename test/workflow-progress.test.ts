import { describe, expect, it } from "vitest";
import type { WorkflowMeta } from "../src/workflow/meta.ts";
import {
  buildPhaseGroups,
  collapse,
  displayState,
  elapsedMs,
  formatDuration,
  header,
  sizeWarning,
  stats,
  type WorkflowAgentEntry,
  type WorkflowEntry,
} from "../src/workflow/progress.ts";

/**
 * Defaults to phase 0 because that is the common case, but `phaseIndex` is
 * genuinely optional — pass `phaseIndex: undefined` to model an agent that ran
 * before any phase() call.
 */
function agentEntry(partial: Partial<WorkflowAgentEntry> & { index: number }): WorkflowAgentEntry {
  return {
    type: "workflow_agent",
    label: `agent-${partial.index}`,
    phaseIndex: 0,
    state: "start",
    ...partial,
  };
}

/** An agent emitted with no ambient phase. */
function unphasedEntry(index: number, partial: Partial<WorkflowAgentEntry> = {}): WorkflowAgentEntry {
  return { ...agentEntry({ index, ...partial }), phaseIndex: undefined, phaseTitle: undefined };
}

describe("collapse", () => {
  it("keeps the last entry written for an index", () => {
    const progress: WorkflowEntry[] = [
      agentEntry({ index: 0, state: "start", label: "first" }),
      agentEntry({ index: 0, state: "done", label: "first", resultPreview: "ok" }),
    ];
    const { agents } = collapse(progress);
    expect(agents).toHaveLength(1);
    expect(agents[0].state).toBe("done");
    expect(agents[0].resultPreview).toBe("ok");
  });

  it("orders agents by index regardless of arrival order", () => {
    const { agents } = collapse([
      agentEntry({ index: 2 }),
      agentEntry({ index: 0 }),
      agentEntry({ index: 1 }),
    ]);
    expect(agents.map(a => a.index)).toEqual([0, 1, 2]);
  });

  it("accumulates logs in order and indexes phase titles", () => {
    const { logs, phaseTitles } = collapse([
      { type: "workflow_log", message: "first" },
      { type: "workflow_phase", index: 0, title: "Scan" },
      { type: "workflow_log", message: "second" },
      { type: "workflow_phase", index: 1, title: "Verify" },
    ]);
    expect(logs).toEqual(["first", "second"]);
    expect(phaseTitles.get(0)).toBe("Scan");
    expect(phaseTitles.get(1)).toBe("Verify");
  });
});

describe("displayState", () => {
  const cases: [string, Partial<WorkflowAgentEntry>, boolean, string][] = [
    ["done wins outright", { state: "done" }, true, "done"],
    ["error + skipped", { state: "error", skipped: true }, true, "skipped"],
    ["bare error", { state: "error" }, true, "failed"],
    ["live but run stopped", { state: "start" }, false, "interrupted"],
    ["queued with no start", { state: "start", queuedAt: 5 }, true, "queued"],
    ["queued then started", { state: "start", queuedAt: 5, startedAt: 6 }, true, "running"],
    ["no queuedAt at all", { state: "start" }, true, "running"],
  ];

  for (const [name, partial, active, expected] of cases) {
    it(name, () => {
      expect(displayState(agentEntry({ index: 0, ...partial }), active)).toBe(expected);
    });
  }

  it("reports done even after the run stops", () => {
    expect(displayState(agentEntry({ index: 0, state: "done" }), false)).toBe("done");
  });
});

describe("buildPhaseGroups", () => {
  it("uses the phase title emitted for that index", () => {
    const groups = buildPhaseGroups([
      { type: "workflow_phase", index: 0, title: "Scan" },
      agentEntry({ index: 0, phaseIndex: 0 }),
    ]);
    expect(groups.map(g => g.title)).toEqual(["Scan"]);
  });

  it("falls back to `Phase N` when no title was emitted", () => {
    const groups = buildPhaseGroups([agentEntry({ index: 0, phaseIndex: 3 })]);
    expect(groups[0].title).toBe("Phase 3");
  });

  it("collapses into a single `Agents` group when no agent has a phase", () => {
    // A script that never calls phase(): still one level of tree.
    const groups = buildPhaseGroups([unphasedEntry(0), unphasedEntry(1)]);
    expect(groups).toHaveLength(1);
    expect(groups[0].title).toBe("Agents");
    expect(groups[0].totalCount).toBe(2);
  });

  it("still shows un-phased agents when meta declared phases", () => {
    // Otherwise the declared placeholders would render and the actual work
    // would vanish from the tree.
    const groups = buildPhaseGroups([unphasedEntry(0)], [{ title: "Scan" }]);
    expect(groups.map(g => g.title)).toEqual(["Scan", "Agents"]);
    expect(groups[1].totalCount).toBe(1);
  });

  it("orders groups by phase index, not first appearance", () => {
    const groups = buildPhaseGroups([
      { type: "workflow_phase", index: 1, title: "Verify" },
      { type: "workflow_phase", index: 0, title: "Scan" },
      agentEntry({ index: 0, phaseIndex: 1 }),
      agentEntry({ index: 1, phaseIndex: 0 }),
    ]);
    expect(groups.map(g => g.title)).toEqual(["Scan", "Verify"]);
  });

  describe("merging with meta.phases", () => {
    it("shows a declared-but-unseen phase as not-started", () => {
      const groups = buildPhaseGroups(
        [{ type: "workflow_phase", index: 0, title: "Scan" }, agentEntry({ index: 0 })],
        [{ title: "Scan" }, { title: "Verify" }],
      );
      expect(groups.map(g => [g.title, g.status])).toEqual([
        ["Scan", "running"],
        ["Verify", "not-started"],
      ]);
    });

    it("matches when the declared title is a prefix of the observed one", () => {
      const groups = buildPhaseGroups(
        [{ type: "workflow_phase", index: 0, title: "Review changed files" }, agentEntry({ index: 0 })],
        [{ title: "Review" }],
      );
      expect(groups).toHaveLength(1);
      expect(groups[0].totalCount).toBe(1);
    });

    it("matches when the observed title is a prefix of the declared one", () => {
      const groups = buildPhaseGroups(
        [{ type: "workflow_phase", index: 0, title: "Review" }, agentEntry({ index: 0 })],
        [{ title: "Review changed files" }],
      );
      expect(groups).toHaveLength(1);
      expect(groups[0].totalCount).toBe(1);
    });

    it("matches case- and whitespace-insensitively", () => {
      const groups = buildPhaseGroups(
        [{ type: "workflow_phase", index: 0, title: "  scan  " }, agentEntry({ index: 0 })],
        [{ title: "Scan" }],
      );
      expect(groups[0].totalCount).toBe(1);
    });

    it("consumes each observed group at most once", () => {
      // Two declared phases both prefix-match "Scan"; the second must not steal
      // the same group, or one phase would double-count the other's agents.
      const groups = buildPhaseGroups(
        [{ type: "workflow_phase", index: 0, title: "Scan" }, agentEntry({ index: 0 })],
        [{ title: "Scan" }, { title: "Sc" }],
      );
      expect(groups.map(g => g.status)).toEqual(["running", "not-started"]);
      expect(groups[0].totalCount).toBe(1);
      expect(groups[1].totalCount).toBe(0);
    });

    it("appends an undeclared phase after the declared ones", () => {
      const groups = buildPhaseGroups(
        [
          { type: "workflow_phase", index: 0, title: "Scan" },
          { type: "workflow_phase", index: 1, title: "Improvise" },
          agentEntry({ index: 0, phaseIndex: 0 }),
          agentEntry({ index: 1, phaseIndex: 1 }),
        ],
        [{ title: "Scan" }],
      );
      expect(groups.map(g => g.title)).toEqual(["Scan", "Improvise"]);
    });
  });

  describe("summarize", () => {
    it("is done only when every agent finished without error", () => {
      const groups = buildPhaseGroups([
        agentEntry({ index: 0, state: "done" }),
        agentEntry({ index: 1, state: "done" }),
      ]);
      expect(groups[0].status).toBe("done");
      expect(groups[0].doneCount).toBe(2);
    });

    it("is failed when any agent errored, even if the rest are done", () => {
      const groups = buildPhaseGroups([
        agentEntry({ index: 0, state: "done" }),
        agentEntry({ index: 1, state: "error" }),
      ]);
      expect(groups[0].status).toBe("failed");
    });

    it("is running while any agent is still live", () => {
      const groups = buildPhaseGroups([
        agentEntry({ index: 0, state: "done" }),
        agentEntry({ index: 1, state: "start" }),
      ]);
      expect(groups[0].status).toBe("running");
    });
  });
});

describe("stats", () => {
  it("counts done and failed toward started", () => {
    const result = stats([
      agentEntry({ index: 0, state: "done" }),
      agentEntry({ index: 1, state: "error" }),
    ]);
    expect(result).toMatchObject({ done: 1, started: 2 });
  });

  it("does not count a queued-but-unstarted agent as started", () => {
    const result = stats([agentEntry({ index: 0, state: "start", queuedAt: 5 })]);
    expect(result.started).toBe(0);
  });

  it("counts a live agent with no queuedAt as started", () => {
    const result = stats([agentEntry({ index: 0, state: "start" })]);
    expect(result.started).toBe(1);
  });

  it("uses the scheduled agent count when it exceeds entries seen", () => {
    // A fan-out reports its size before its agents emit anything.
    const result = stats([agentEntry({ index: 0, state: "done" })], 7);
    expect(result.total).toBe(7);
  });

  it("ignores log and phase entries", () => {
    const result = stats([
      { type: "workflow_log", message: "hi" },
      { type: "workflow_phase", index: 0, title: "Scan" },
    ]);
    expect(result).toMatchObject({ done: 0, total: 0, started: 0 });
  });
});

describe("elapsedMs", () => {
  it("uses now while running", () => {
    expect(elapsedMs({ startTime: 1000 }, 4000)).toBe(3000);
  });

  it("freezes at endTime once finished", () => {
    expect(elapsedMs({ startTime: 1000, endTime: 2500 }, 9999)).toBe(1500);
  });

  it("subtracts paused time", () => {
    expect(elapsedMs({ startTime: 1000, totalPausedMs: 500 }, 4000)).toBe(2500);
  });

  it("never goes negative", () => {
    expect(elapsedMs({ startTime: 1000, totalPausedMs: 99_999 }, 2000)).toBe(0);
  });
});

describe("formatDuration", () => {
  it.each([
    [0, "0ms"],
    [340, "340ms"],
    [9000, "9s"],
    [72_000, "1m12s"],
    [3_600_000, "60m00s"],
  ])("formats %ims as %s", (ms, expected) => {
    expect(formatDuration(ms)).toBe(expected);
  });
});

describe("header", () => {
  const meta: WorkflowMeta = { name: "review-changes", description: "review the diff" };
  const task = { status: "running" as const, startTime: 1000 };

  it("renders count and elapsed with no phase count", () => {
    const groups = buildPhaseGroups([
      agentEntry({ index: 0, state: "done" }),
      agentEntry({ index: 1, state: "start" }),
    ]);
    const line = header(task, meta, groups, 7, 73_000);
    expect(line.stats).toBe("1/7 agents · 1m12s");
    expect(line.name).toBe("review-changes");
    expect(line.subtext).toBe("review the diff");
  });

  it("singularizes a lone agent", () => {
    const groups = buildPhaseGroups([agentEntry({ index: 0, state: "done" })]);
    expect(header(task, meta, groups, 1, 2000).stats).toBe("1/1 agent · 1s");
  });

  it.each([
    ["completed", " · done"],
    ["killed", " · stopped"],
    ["paused", " · paused"],
    ["failed", " · failed"],
  ] as const)("appends the %s suffix", (status, suffix) => {
    const groups = buildPhaseGroups([agentEntry({ index: 0, state: "done" })]);
    const line = header({ ...task, status }, meta, groups, 1, 2000);
    expect(line.stats.endsWith(suffix)).toBe(true);
  });

  it("adds no suffix while running", () => {
    const groups = buildPhaseGroups([agentEntry({ index: 0, state: "done" })]);
    expect(header(task, meta, groups, 1, 2000).stats).toBe("1/1 agent · 1s");
  });

  it("prefers the task's workflow name over meta", () => {
    const groups = buildPhaseGroups([]);
    const line = header({ ...task, workflowName: "pinned" }, meta, groups, 0, 1000);
    expect(line.name).toBe("pinned");
  });
});

describe("sizeWarning", () => {
  it("stays silent for an ordinary run", () => {
    expect(sizeWarning({ scheduledAgents: 5, startedAgents: 5, totalTokens: 10_000 })).toBe(false);
  });

  it("fires on the agent axis past the cap", () => {
    expect(sizeWarning({ scheduledAgents: 26, startedAgents: 1, totalTokens: 10 })).toBe(true);
  });

  it("does not fire exactly at the cap", () => {
    expect(sizeWarning({ scheduledAgents: 25, startedAgents: 25, totalTokens: 10 })).toBe(false);
  });

  it("projects spend from agents that have already reported", () => {
    // 10 started at 100k each, 20 scheduled → projects 2M, over the 1.5M cap.
    expect(sizeWarning({ scheduledAgents: 20, startedAgents: 10, totalTokens: 1_000_000 })).toBe(true);
  });

  it("assumes a per-agent cost before anything has started", () => {
    // 22 agents × 70k assumed = 1.54M, over cap, while under the agent cap.
    expect(sizeWarning({ scheduledAgents: 22, startedAgents: 0, totalTokens: 0 })).toBe(true);
    expect(sizeWarning({ scheduledAgents: 21, startedAgents: 0, totalTokens: 0 })).toBe(false);
  });

  it("never projects below what has already been spent", () => {
    expect(sizeWarning({ scheduledAgents: 1, startedAgents: 10, totalTokens: 2_000_000 })).toBe(true);
  });
});
