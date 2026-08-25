/**
 * agent-question-tools.ts — the child↔parent question round trip, shared by the
 * nested delegation path and any future root answering surface.
 *
 * Two tools, built per-session by factories so identity is captured at
 * construction, never read from model params:
 *
 *   - `ask_parent`: injected into a CHILD session. The closure captures the
 *     child's own manager-assigned id; the parent (its spawner) answers.
 *   - `answer_subagent_question`: injected into a PARENT session (via
 *     createNestedSubagentTools), or registered in the root session with
 *     `responderAgentId: undefined`. The closure captures the responder's id
 *     (or undefined for the root), which is exactly the ownership the
 *     manager's `answerQuestion` requires.
 */

import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";

/** Stable tool-name constants — single source of truth for registration and scoping. */
export const AGENT_QUESTION_TOOL_NAMES = {
  ASK_PARENT: "ask_parent",
  ANSWER_SUBAGENT_QUESTION: "answer_subagent_question",
} as const;

/**
 * The slice of AgentManager the question tools need. Structural so this module
 * stays free of agent-manager's dependency cycle (agent-manager → agent-runner
 * → agent-question-tools) and testable with a plain fake.
 */
export interface AgentQuestionManager {
  askParent(childAgentId: string, question: string, signal?: AbortSignal): Promise<string>;
  answerQuestion(questionId: string, answer: string, responderAgentId?: string): void;
  getRecord(id: string): { isBackground?: boolean } | undefined;
}

function textResult(text: string, isError = false) {
  return { content: [{ type: "text" as const, text }], isError, details: {} };
}

/**
 * The child's side: ask the agent that spawned it a question and wait for the
 * parent's answer. `childAgentId` is captured at build time — the session's own
 * manager-assigned id, never derivable from model params.
 */
export function createAskParentTool(
  manager: AgentQuestionManager,
  childAgentId: string,
): ToolDefinition {
  return defineTool({
    name: AGENT_QUESTION_TOOL_NAMES.ASK_PARENT,
    label: "Ask Parent",
    description:
      "Ask the agent that spawned you a question and wait for its answer. " +
      "Use when only your parent can decide or provide information. You are " +
      "blocked until it answers, so prefer deciding on your own when possible.",
    parameters: Type.Object({ question: Type.String() }),
    execute: async (_toolCallId, params, signal) => {
      if (!params.question.trim()) {
        return textResult("Question must not be empty or whitespace-only.", true);
      }
      // A foreground child's parent is blocked waiting for it, so it can never
      // answer — reject with the actionable opt-out instead of stranding the
      // question until the child settles.
      const record = manager.getRecord(childAgentId);
      if (record?.isBackground === false) {
        return textResult(
          `Agent "${childAgentId}" runs in the foreground — its parent is blocked ` +
            "waiting for it and cannot answer questions. Spawn it with " +
            "run_in_background: true instead.",
          true,
        );
      }
      try {
        // The execute AbortSignal forwards unchanged: cancelling the tool call
        // cancels the pending question with it.
        const answer = await manager.askParent(childAgentId, params.question, signal);
        return textResult(answer);
      } catch (err) {
        return textResult(err instanceof Error ? err.message : String(err), true);
      }
    },
  });
}

/**
 * The parent's side: answer a question one of its children asked. The closure
 * captures `responderAgentId` — the parent session's own id, which the manager
 * enforces as exact ownership of the question. `undefined` is the root
 * session, which only owns questions from top-level children.
 */
export function createAnswerSubagentQuestionTool(
  manager: AgentQuestionManager,
  responderAgentId: string | undefined,
): ToolDefinition {
  return defineTool({
    name: AGENT_QUESTION_TOOL_NAMES.ANSWER_SUBAGENT_QUESTION,
    label: "Answer Subagent Question",
    description:
      "Answer a question a child agent asked you. The question_id identifies " +
      "the pending question; your answer resolves the child's ask_parent call.",
    parameters: Type.Object({
      question_id: Type.String(),
      answer: Type.String(),
    }),
    execute: async (_toolCallId, params) => {
      try {
        manager.answerQuestion(params.question_id, params.answer, responderAgentId);
      } catch (err) {
        return textResult(err instanceof Error ? err.message : String(err), true);
      }
      return textResult("Answer delivered to the subagent.");
    },
  });
}
