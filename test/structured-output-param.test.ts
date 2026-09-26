/**
 * structured-output-param.test.ts — the `schema` parameter on the `Agent` tools.
 *
 * `agent(prompt, { schema })` inside a workflow already had structured output;
 * this pins the same capability reaching the top-level `Agent` tool, the nested
 * one, and the `subagents:rpc:spawn` channel — plus the four places a result is
 * read back, which must prefer the payload over the prose.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

import { runAgent } from "../src/agent-runner.js";
import { registerAgents } from "../src/agent-types.js";
import { type EventBus, registerRpcHandlers, type SpawnCapable } from "../src/cross-extension-rpc.js";
import { loadCustomAgents } from "../src/custom-agents.js";
import subagentsExtension from "../src/index.js";
import { createNestedSubagentTools, type NestedAgentManager } from "../src/nested-tools.js";
import { resolveStorePath, ScheduleStore } from "../src/schedule-store.js";
import { ctx, flush, type Hermetic, hermeticDir, makePi, textOf } from "./helpers/boot-extension.js";

const SCHEMA = { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] };
const PAYLOAD = '{"answer":"42"}';

/** pi-subagents holds a completion notification for NUDGE_HOLD_MS (200ms). */
const PAST_THE_HOLD_MS = 500;

function mockRun(extra: Record<string, unknown> = {}) {
  // The module mock is one `vi.fn` for the whole file, so its call log outlives
  // `restoreAllMocks` — a "did not spawn" assertion needs it cleared here.
  vi.mocked(runAgent).mockReset();
  vi.mocked(runAgent).mockResolvedValue({
    responseText: "PROSE-RESULT",
    session: { dispose: vi.fn() } as any,
    aborted: false,
    steered: false,
    ...extra,
  } as any);
}

describe("Agent tool `schema` parameter", () => {
  let hermetic: Hermetic;

  beforeEach(() => {
    hermetic = hermeticDir({ settings: { outputTranscript: false } });
  });

  afterEach(() => {
    hermetic.restore();
    vi.restoreAllMocks();
  });

  function boot() {
    const booted = makePi();
    subagentsExtension(booted.pi);
    return booted;
  }

  const spawnParams = (extra: Record<string, unknown>) => ({
    prompt: "find the answer",
    description: "find the answer",
    subagent_type: "Explore",
    run_in_background: false,
    ...extra,
  });

  it("declares `schema` on the tool's parameters", () => {
    const props = boot().tools.get("Agent").parameters?.properties ?? {};
    expect(props.schema).toBeDefined();
    expect(props.schema.type).toBe("object");
    expect(props.schema.description).toMatch(/StructuredOutput/);
  });

  it("compiles the schema and hands it to the run as `structuredOutput`", async () => {
    mockRun({ structuredJson: PAYLOAD });
    const { tools } = boot();
    await tools.get("Agent").execute("tc-1", spawnParams({ schema: SCHEMA }), undefined, undefined, ctx());

    const options = vi.mocked(runAgent).mock.calls[0][3] as { structuredOutput?: { schema: unknown } };
    expect(options.structuredOutput?.schema).toEqual(SCHEMA);
  });

  it("rejects a schema that cannot be a tool input schema, without spawning", async () => {
    mockRun();
    const { tools } = boot();
    const res = await tools.get("Agent").execute(
      "tc-2",
      spawnParams({ schema: { type: "string" } }),
      undefined,
      undefined,
      ctx(),
    );

    expect(textOf(res)).toContain("`schema` must have `type: \"object\"` at its root");
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("refuses `schema` with `resume` — a reopened session has no StructuredOutput tool", async () => {
    mockRun();
    const { tools } = boot();
    const res = await tools.get("Agent").execute(
      "tc-3",
      spawnParams({ schema: SCHEMA, resume: "some-agent" }),
      undefined,
      undefined,
      ctx(),
    );

    expect(textOf(res)).toContain("Cannot combine `schema` with `resume`");
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("returns the payload, not the prose, from a foreground run", async () => {
    mockRun({ structuredJson: PAYLOAD });
    const { tools } = boot();
    const res = await tools.get("Agent").execute("tc-4", spawnParams({ schema: SCHEMA }), undefined, undefined, ctx());

    expect(textOf(res)).toContain(PAYLOAD);
    expect(textOf(res)).not.toContain("PROSE-RESULT");
  });

  it("still returns prose when no schema was asked for", async () => {
    mockRun();
    const { tools } = boot();
    const res = await tools.get("Agent").execute("tc-5", spawnParams({}), undefined, undefined, ctx());

    expect(textOf(res)).toContain("PROSE-RESULT");
  });

  it("returns the payload from get_subagent_result", async () => {
    mockRun({ structuredJson: PAYLOAD });
    const { tools } = boot();
    const spawned = await tools.get("Agent").execute("tc-6", spawnParams({ schema: SCHEMA }), undefined, undefined, ctx());
    const id = (spawned as any).details?.agentId as string;

    const read = await tools.get("get_subagent_result").execute("tc-7", { agent_id: id }, undefined, undefined, ctx());
    expect(textOf(read)).toContain(PAYLOAD);
    expect(textOf(read)).not.toContain("PROSE-RESULT");
  });

  it("previews the payload in the completion notification", async () => {
    mockRun({ structuredJson: PAYLOAD });
    const { pi, tools, lifecycle } = boot();
    await lifecycle.get("session_start")?.({}, ctx());
    await tools.get("Agent").execute(
      "tc-8",
      spawnParams({ schema: SCHEMA, run_in_background: true }),
      undefined,
      undefined,
      ctx(),
    );
    await flush();
    await new Promise((r) => setTimeout(r, PAST_THE_HOLD_MS));

    const notes = pi.sendMessage.mock.calls
      .filter((c: any[]) => c[0]?.customType === "subagent-notification")
      .map((c: any[]) => c[0].content as string);
    expect(notes.join("\n")).toContain(PAYLOAD);
    expect(notes.join("\n")).not.toContain("PROSE-RESULT");

    await lifecycle.get("session_shutdown")?.({}, ctx());
  });

  it("carries the payload on the `subagents:completed` event", async () => {
    mockRun({ structuredJson: PAYLOAD });
    const { pi, tools, lifecycle } = boot();
    await lifecycle.get("session_start")?.({}, ctx());
    await tools.get("Agent").execute(
      "tc-9",
      spawnParams({ schema: SCHEMA, run_in_background: true }),
      undefined,
      undefined,
      ctx(),
    );
    await flush();

    const completed = pi.events.emit.mock.calls.find((c: any[]) => c[0] === "subagents:completed");
    expect(completed?.[1]).toMatchObject({ result: "PROSE-RESULT", structuredJson: PAYLOAD });

    await lifecycle.get("session_shutdown")?.({}, ctx());
  });

  it("persists the raw schema on a scheduled job so the fire can recompile it", async () => {
    const { tools, lifecycle } = boot();
    const c = ctx({ sessionManager: { getSessionId: vi.fn(() => "sched-schema"), getBranch: vi.fn(() => []) } });
    await lifecycle.get("session_start")?.({}, c);
    await tools.get("Agent").execute(
      "tc-10",
      { prompt: "sweep", description: "nightly sweep", subagent_type: "Explore", schedule: "5m", schema: SCHEMA },
      undefined,
      undefined,
      c,
    );

    const jobs = new ScheduleStore(resolveStorePath(c.cwd, "sched-schema")).list();
    expect(jobs[0]?.schema).toEqual(SCHEMA);
    await lifecycle.get("session_shutdown")?.({}, c);
  });
});

describe("nested Agent tool `schema` parameter", () => {
  let cwd: string;
  let spawnAndWait: ReturnType<typeof vi.fn>;
  let manager: NestedAgentManager;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "nested-schema-"));
    mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "agents", "scout.md"), "---\ndescription: scout\ntools: read\n---\nscout\n");
    registerAgents(loadCustomAgents(cwd));
    spawnAndWait = vi.fn(async () => ({
      id: "child-1",
      record: { id: "child-1", status: "completed", result: "PROSE-RESULT", structuredJson: PAYLOAD },
    }));
    manager = {
      spawn: vi.fn(),
      spawnAndWait,
      awaitStartup: vi.fn(async () => {}),
      getRecord: vi.fn(),
      resume: vi.fn(),
    } as any;
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function nestedAgentTool() {
    return createNestedSubagentTools({
      manager,
      pi: {} as any,
      parentAgentId: "parent-1",
      depth: 1,
      maxSubagentDepth: 2,
      allowedSubagents: "all",
      configCwd: cwd,
    })[0];
  }

  const run = (params: Record<string, unknown>) =>
    nestedAgentTool().execute(
      "call-1",
      { subagent_type: "scout", description: "scout it", prompt: "Scout it", ...params },
      undefined,
      undefined,
      { cwd, model: undefined, modelRegistry: { find: vi.fn(), getAvailable: () => [], getAll: () => [] } } as any,
    );

  it("declares `schema` on the nested tool's parameters", () => {
    const props = (nestedAgentTool() as any).parameters?.properties ?? {};
    expect(props.schema).toBeDefined();
    expect(props.schema.description).toMatch(/StructuredOutput/);
  });

  it("passes the compiled schema to the nested spawn and returns the payload", async () => {
    const res = await run({ schema: SCHEMA });

    expect(spawnAndWait.mock.calls[0][4].structuredOutput.schema).toEqual(SCHEMA);
    expect(textOf(res)).toContain(PAYLOAD);
    expect(textOf(res)).not.toContain("PROSE-RESULT");
  });

  it("rejects a bad schema and refuses `resume`", async () => {
    const bad = await run({ schema: { type: "array" } });
    expect(bad.isError).toBe(true);
    expect(textOf(bad)).toContain("`schema` must have `type: \"object\"` at its root");

    const resumed = await run({ schema: SCHEMA, resume: "child-1" });
    expect(resumed.isError).toBe(true);
    expect(textOf(resumed)).toContain("Cannot combine `schema` with `resume`");
    expect(spawnAndWait).not.toHaveBeenCalled();
  });
});

describe("subagents:rpc:spawn `schema` option", () => {
  function createEventBus(): EventBus {
    const listeners = new Map<string, Set<(data: unknown) => void>>();
    return {
      on(event, handler) {
        if (!listeners.has(event)) listeners.set(event, new Set());
        listeners.get(event)!.add(handler);
        return () => { listeners.get(event)?.delete(handler); };
      },
      emit(event, data) {
        for (const handler of listeners.get(event) ?? []) handler(data);
      },
    };
  }

  function setup() {
    const events = createEventBus();
    const manager: SpawnCapable = {
      spawn: vi.fn().mockReturnValue("agent-42"),
      awaitStartup: vi.fn().mockResolvedValue(undefined),
      abort: vi.fn().mockReturnValue(true),
      getRecord: vi.fn().mockReturnValue({}),
      consumeResult: vi.fn().mockReturnValue(true),
    };
    registerRpcHandlers({ events, pi: { events }, getCtx: () => ({ session: true }), manager });
    return { events, manager };
  }

  it("compiles a raw JSON schema into `structuredOutput`", async () => {
    const { events, manager } = setup();
    const reply = vi.fn();
    events.on("subagents:rpc:spawn:reply:req-1", reply);
    events.emit("subagents:rpc:spawn", {
      requestId: "req-1", type: "general-purpose", prompt: "do stuff", options: { schema: SCHEMA },
    });

    await vi.waitFor(() => expect(reply).toHaveBeenCalled());
    expect(reply).toHaveBeenCalledWith({ success: true, data: { id: "agent-42" } });
    const options = vi.mocked(manager.spawn).mock.calls[0][4];
    expect(options.structuredOutput.schema).toEqual(SCHEMA);
    // The raw field is consumed, not forwarded — the manager knows only the
    // compiled option.
    expect(options.schema).toBeUndefined();
  });

  it("answers an unusable schema with an error envelope and spawns nothing", async () => {
    const { events, manager } = setup();
    const reply = vi.fn();
    events.on("subagents:rpc:spawn:reply:req-2", reply);
    events.emit("subagents:rpc:spawn", {
      requestId: "req-2", type: "general-purpose", prompt: "do stuff", options: { schema: "nope" },
    });

    await vi.waitFor(() => expect(reply).toHaveBeenCalled());
    expect(reply).toHaveBeenCalledWith({
      success: false,
      error: "spawn options.schema must be a JSON Schema object.",
    });
    expect(manager.spawn).not.toHaveBeenCalled();
  });
});
