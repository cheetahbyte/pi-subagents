/**
 * context.ts — Extract parent conversation context for subagent inheritance.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Extract text from a message content block array. */
export function extractText(content: unknown[]): string {
  return content
    .filter((c: any) => c.type === "text")
    .map((c: any) => c.text ?? "")
    .join("\n");
}

const TOOL_RESULT_MAX = 200;
const TOOL_ARGS_MAX = 120;

/** One line per tool call: name plus a compact argument summary. */
function describeToolCalls(content: unknown[]): string[] {
  const out: string[] = [];
  for (const c of content as any[]) {
    if (c?.type !== "toolCall") continue;
    const name = c.name ?? c.toolName ?? "unknown";
    let args = "";
    try { args = JSON.stringify(c.arguments ?? c.input ?? {}); } catch { args = ""; }
    if (args.length > TOOL_ARGS_MAX) args = args.slice(0, TOOL_ARGS_MAX) + "…";
    out.push(`  ${name} ${args}`.trimEnd());
  }
  return out;
}

/**
 * Build a text representation of the parent conversation context.
 * Used when inherit_context is true to give the subagent visibility
 * into what has been discussed/done so far.
 */
export function buildParentContext(ctx: ExtensionContext): string {
  const entries = ctx.sessionManager.getBranch();
  if (!entries || entries.length === 0) return "";

  const parts: string[] = [];

  for (const entry of entries) {
    if (entry.type === "message") {
      const msg = entry.message;
      if (msg.role === "user") {
        const text = typeof msg.content === "string"
          ? msg.content
          : extractText(msg.content);
        if (text.trim()) parts.push(`[User]: ${text.trim()}`);
      } else if (msg.role === "assistant") {
        const text = extractText(msg.content);
        if (text.trim()) parts.push(`[Assistant]: ${text.trim()}`);
        const calls = describeToolCalls(msg.content);
        if (calls.length > 0) parts.push(`[Tool Calls]:\n${calls.join("\n")}`);
      } else if (msg.role === "toolResult") {
        // Truncated, not skipped: a child that cannot see what the parent
        // already read re-reads it, and that is most of "double exploration".
        const text = extractText(msg.content).trim();
        if (text) {
          const name = msg.toolName ?? "tool";
          parts.push(`[Tool Result (${name})]: ${text.length > TOOL_RESULT_MAX ? text.slice(0, TOOL_RESULT_MAX) + "…" : text}`);
        }
      }
    } else if (entry.type === "compaction") {
      // Include compaction summaries — they're already condensed
      if (entry.summary) {
        parts.push(`[Summary]: ${entry.summary}`);
      }
    }
  }

  if (parts.length === 0) return "";

  return `# Parent Conversation Context
The following is the conversation history from the parent session that spawned you.
Use this context to understand what has been discussed and decided so far.
Tool calls and results show what the parent has already searched and read — do not repeat that work.

${parts.join("\n\n")}

---
# Your Task (below)
`;
}
