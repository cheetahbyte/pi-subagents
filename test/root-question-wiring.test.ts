/**
 * root-question-wiring.test.ts — a top-level child's ask_parent round trip
 * through the root session.
 *
 * The child's question must reach the root session as a `subagent_question`
 * steer message that carries the exact question id (in both the visible
 * content and the structured details), plus the child's identity, the question
 * text, and an `answer_subagent_question` hint. The root's actually registered
 * `answer_subagent_question` tool must then settle it — with responder
 * identity `undefined`, which is the exact ownership the manager requires for
 * a root question.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn(), steerAgent: vi.fn() };
});

import { type AgentQuestionManager, createAskParentTool } from "../src/agent-question-tools.js";
import type { RunResult } from "../src/agent-runner.js";
import { runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";
import { ctx, flush, makePi, textOf } from "./helpers/boot-extension.js";

afterEach(() => {
  vi.mocked(runAgent).mockReset();
});

describe("top-level child questions in the root session", () => {
  it("steers the question to the root and settles it through the registered answer tool", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);

    // A running background child, as the Agent tool spawns it. Capture the
    // manager from the runAgent invocation's nestedRuntime — the same manager
    // the child's ask_parent tool will be built against.
    let manager: AgentQuestionManager | undefined;
    vi.mocked(runAgent).mockImplementation((_ctx, _type, _prompt, opts) => {
      manager = opts.nestedRuntime?.manager;
      return new Promise<RunResult>(() => {});
    });
    const spawnResult = await tools.get("Agent").execute(
      "tc-spawn",
      { prompt: "go", description: "wiring child", subagent_type: "general-purpose", run_in_background: true },
      undefined,
      undefined,
      ctx(),
    );
    const childId = /Agent ID: (\S+)/.exec(textOf(spawnResult))![1];
    await flush();
    expect(manager).toBeDefined();

    // The child asks exactly as its ask_parent tool would — through the same
    // manager, so the root's registered tool can settle the pending question.
    const ask = createAskParentTool(manager!, childId);
    const askResult = ask.execute("tc-ask", { question: "which repo?" }, undefined, undefined, ctx());
    await flush();

    // The root session received exactly one steer message carrying the
    // question id in both the visible content and the structured details.
    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
    const [msg, opts] = pi.sendMessage.mock.calls[0];
    expect(msg.customType).toBe("subagent_question");
    expect(msg.details.questionId).toEqual(expect.any(String));
    expect(msg.content).toContain(msg.details.questionId);
    expect(msg.details).toMatchObject({
      childAgentId: childId,
      childType: "general-purpose",
      childDescription: "wiring child",
      question: "which repo?",
    });
    expect(msg.content).toContain("wiring child");
    expect(msg.content).toContain("which repo?");
    expect(msg.content).toContain("answer_subagent_question");
    expect(opts).toEqual({ deliverAs: "steer", triggerTurn: true });

    // The root answers through the tool that was actually registered.
    const answer = await tools.get("answer_subagent_question").execute(
      "tc-answer",
      { question_id: msg.details.questionId, answer: "pi-subagents" },
      undefined,
      undefined,
      ctx(),
    );
    expect(textOf(answer)).toContain("Answer delivered");

    // The child's ask_parent promise resolves with the answer — only possible
    // because the tool answered with the root identity (undefined), which the
    // manager enforces as exact ownership of a top-level question.
    expect(textOf(await askResult)).toBe("pi-subagents");

    await lifecycle.get("session_shutdown")?.();
  });
});
