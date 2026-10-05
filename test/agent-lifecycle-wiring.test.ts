/**
 * Wiring between the Agent tool, the completion notifications and the session
 * lifecycle in index.ts — the seams no manager-level test reaches.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.ts", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.ts")>("../src/agent-runner.ts");
  return { ...actual, runAgent: vi.fn() };
});

import { runAgent } from "../src/agent-runner.ts";
import { GroupJoinManager } from "../src/group-join.ts";
import subagentsExtension from "../src/index.ts";

function makePi() {
  const tools = new Map<string, any>();
  const lifecycle = new Map<string, any>();
  const commands = new Map<string, any>();
  const pi = {
    registerMessageRenderer: vi.fn(),
    registerTool: vi.fn((tool: any) => tools.set(tool.name, tool)),
    registerCommand: vi.fn((name: string, command: any) => commands.set(name, command)),
    registerEntryRenderer: vi.fn(),
    registerFlag: vi.fn(),
    getFlag: vi.fn(),
    on: vi.fn((event: string, handler: any) => lifecycle.set(event, handler)),
    events: { emit: vi.fn(), on: vi.fn(() => vi.fn()) },
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
  } as any;
  return { pi, tools, lifecycle, commands };
}

function makeCtx(cwd: string) {
  return {
    hasUI: false,
    ui: { setStatus: vi.fn(), setWidget: vi.fn(), notify: vi.fn(), select: vi.fn(), custom: vi.fn() },
    cwd,
    model: undefined,
    modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
    sessionManager: { getSessionId: vi.fn(() => "session-1"), getBranch: vi.fn(() => []) },
    getSystemPrompt: vi.fn(() => "parent"),
    isProjectTrusted: () => true,
  } as any;
}

const textOf = (result: any): string => result.content[0].text;
const agentIdOf = (result: any): string => /Agent ID: (\S+)/.exec(textOf(result))![1];

describe("agent lifecycle wiring", () => {
  let cwd: string;
  let agentDir: string;
  let previousCwd: string;
  let previousAgentDir: string | undefined;
  let previousHome: string | undefined;

  function writeSettings(settings: Record<string, unknown>) {
    writeFileSync(join(cwd, ".pi", "subagents.json"), JSON.stringify(settings));
  }

  function spawn(tools: Map<string, any>, ctx: any, extra: Record<string, unknown> = {}) {
    return tools.get("Agent").execute(
      "spawn-call",
      { prompt: "task", description: "Task", subagent_type: "general-purpose", run_in_background: true, ...extra },
      undefined,
      undefined,
      ctx,
    );
  }

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "pi-lifecycle-cwd-"));
    agentDir = mkdtempSync(join(tmpdir(), "pi-lifecycle-agent-"));
    previousCwd = process.cwd();
    previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    previousHome = process.env.HOME;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.HOME = agentDir;
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeSettings({ schedulingEnabled: false });
    mkdirSync(join(agentDir, "agents"), { recursive: true });
    process.chdir(cwd);
    vi.useFakeTimers();

    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, options: any) => {
      await Promise.resolve();
      const session = { messages: [], subscribe: vi.fn(() => vi.fn()), dispose: vi.fn() };
      options.onSessionCreated?.(session);
      options.onTurnEnd?.(3);
      return { responseText: "done", session, aborted: false, steered: false } as any;
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    process.chdir(previousCwd);
    if (previousAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    if (previousHome == null) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(cwd, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("carries the run's turn count into the completion notification", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    const ctx = makeCtx(cwd);

    await spawn(tools, ctx, { max_turns: 10 });
    await vi.advanceTimersByTimeAsync(500);

    const notification = pi.sendMessage.mock.calls.find((c: any[]) => c[0]?.customType === "subagent-notification");
    expect(notification?.[0].details).toMatchObject({ turnCount: 3, maxTurns: 10 });

    await lifecycle.get("session_shutdown")?.({}, ctx);
  });

  it("drops the pending batch and group timers on shutdown", async () => {
    const dispose = vi.spyOn(GroupJoinManager.prototype, "dispose");
    const registerGroup = vi.spyOn(GroupJoinManager.prototype, "registerGroup");
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    const ctx = makeCtx(cwd);

    await spawn(tools, ctx);
    await spawn(tools, ctx);
    await lifecycle.get("session_shutdown")?.({}, ctx);
    await vi.advanceTimersByTimeAsync(500);

    expect(dispose).toHaveBeenCalled();
    expect(registerGroup).not.toHaveBeenCalled();
  });

  it("cancels the held notification when the result is read by handle", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    const ctx = makeCtx(cwd);

    await spawn(tools, ctx, { name: "auth-audit" });
    await vi.advanceTimersByTimeAsync(150); // past the batch debounce, inside the notification hold
    const held = vi.getTimerCount();

    const result = await tools.get("get_subagent_result").execute("c", { agent_id: "auth-audit" }, undefined, undefined, ctx);

    expect(textOf(result)).toContain("done");
    expect(vi.getTimerCount()).toBe(held - 1);

    await lifecycle.get("session_shutdown")?.({}, ctx);
  });

  it("reports a queued agent as queued rather than as having no output", async () => {
    writeSettings({ schedulingEnabled: false, maxConcurrent: 1 });
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    const ctx = makeCtx(cwd);

    await spawn(tools, ctx);
    const queued = await spawn(tools, ctx);
    expect(textOf(queued)).toContain("queued in background");

    const result = await tools.get("get_subagent_result").execute("c", { agent_id: agentIdOf(queued) }, undefined, undefined, ctx);

    expect(textOf(result)).toContain("Agent is queued");
    expect(textOf(result)).not.toContain("No output.");

    const shutdown = lifecycle.get("session_shutdown")?.({}, ctx);
    await vi.advanceTimersByTimeAsync(60_000);
    await shutdown;
  });

  it("restarts the scheduler when scheduling is switched back on mid-session", async () => {
    initTheme(undefined, false);
    writeSettings({});
    const { pi, tools, lifecycle, commands } = makePi();
    subagentsExtension(pi);
    const ctx = makeCtx(cwd);
    await lifecycle.get("session_start")?.({}, ctx);

    // /agents → Settings, then cycle the Scheduling row (index 7) off and on.
    ctx.ui.select.mockResolvedValueOnce("Settings").mockResolvedValue(undefined);
    ctx.ui.custom.mockImplementation(async (factory: any) => {
      const component = factory({ requestRender: vi.fn() }, {}, {}, vi.fn());
      for (let i = 0; i < 7; i++) component.handleInput("\x1b[B");
      component.handleInput("\r");
      component.handleInput("\r");
      return undefined;
    });
    await commands.get("agents").handler("", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Scheduling enabled"), expect.anything());

    const result = await spawn(tools, ctx, { run_in_background: undefined, schedule: "+10m" });
    expect(textOf(result)).toContain("Scheduled");

    await lifecycle.get("session_shutdown")?.({}, ctx);
  });
});
