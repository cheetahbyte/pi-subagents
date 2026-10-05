/**
 * status-note.ts — Honest framing for an agent result: the parenthetical status
 * note for a non-normal outcome, and the salvaged partial output of a failure.
 *
 * Lives here rather than in an index.ts closure because both entry points need
 * it — the top-level tools and the nested delegation tools, which can't import
 * from index.ts (that is the extension entry, and it already reaches these tools
 * through agent-runner).
 */

import { formatSize, truncateHead } from "@earendil-works/pi-coding-agent";
import type { AgentRecord } from "./types.ts";

/** Which limit ended a "steered" or "aborted" run: its `timeout`, or its turn budget. */
export function limitName(timedOut = false): string {
  return timedOut ? "time limit" : "turn limit";
}

/**
 * Explicit parenthetical note for a non-normal terminal outcome, so the parent
 * agent can't mistake partial output for a completed result. Empty string for a
 * clean completion (and any unknown/non-terminal status).
 *
 * `stopped` (a human aborted it) is deliberately distinct from `aborted` (the
 * turn limit was hit) — the parent should treat human intervention differently
 * from a budget cutoff.
 */
export function getStatusNote(status: string, timedOut = false): string {
  const limit = limitName(timedOut);
  switch (status) {
    case "stopped":
      return " (STOPPED BY THE USER before completion — output is partial; the task was NOT finished)";
    case "aborted":
      return ` (aborted — hit the ${limit} before completion; output may be incomplete)`;
    case "steered":
      return ` (wrapped up at the ${limit} — output may be partial)`;
    default:
      return "";
  }
}

/**
 * Foreground variant of `getStatusNote`. A foreground caller is in a different
 * position from a background one, so it needs different text:
 *
 *   - It already holds the agent's ENTIRE output inline, whereas the background
 *     notification carries a 500-char preview. So only here can we truthfully
 *     say there is nothing more to fetch — which is the whole point, because
 *   - it has no agent id. The id travels in the tool result's renderer
 *     `details`, which is never serialized to the model. A parent that reads
 *     "output may be partial" as "truncated, go retrieve the rest" therefore
 *     has nothing valid to call `get_subagent_result` with, and will invent an
 *     id (#174).
 *
 * Only the lead clause varies between the three, and each variation carries
 * information: `wrapped up` vs `aborted` tells the parent whether the output is
 * a considered final answer or a fragment, and `stopped` shouts because a human
 * intervening outranks everything else in the string. Only `steered` hedges on
 * completion — it was told to wrap up and did, so it may well have finished at
 * the limit; an aborted run blew through its grace turns while still working,
 * and `stopped` can only fire on a running agent, so neither ever delivered a
 * final answer. Identical confidence gets identical wording: phrasing one fact
 * two ways invites a hunt for a distinction that isn't there.
 *
 * Every clause is a statement about state, never an instruction to act, and
 * `get_subagent_result` is never named — naming the tool we steer away from only
 * raises its salience. Two instructions were tried here and cut: "re-spawn with
 * a higher max_turns" (pushes a fresh multi-minute run to save one wasted tool
 * call) and, on `stopped`, "ask before restarting it" (restates the lead, and
 * presumes someone is present to ask — false under `pi -p`, in scheduled jobs,
 * and in any background-driven run). Nothing here can measure whether wording
 * improves parent behavior, so removing a false cue (which cannot induce new
 * behavior) and adding an instruction (which can) are not equally safe bets.
 * Don't add either back without a way to measure it.
 */
export function getForegroundOutcomeNote(status: string, timedOut = false): string {
  const limit = limitName(timedOut);
  switch (status) {
    case "stopped":
      return " (STOPPED BY THE USER — everything the agent produced is above; the task is unfinished)";
    case "aborted":
      return ` (aborted at the ${limit} — everything the agent produced is above; the task is unfinished)`;
    case "steered":
      return ` (wrapped up at the ${limit} — everything the agent produced is above; the task may be unfinished)`;
    default:
      return "";
  }
}

/**
 * Salvaged partial output of a failed run, as a labeled suffix for the error
 * surfaces (or "" if the run produced nothing). `record.result` is bounded to
 * the run's own turns, so this is never a stale earlier answer (#144).
 */
export function partialOutputSuffix(record: AgentRecord): string {
  const partial = record.result?.trim();
  return partial ? `\n\nPartial output before the failure:\n${capResult(partial, record.outputFile)}` : "";
}

/**
 * Bound an agent's prose result before it enters the caller's context, and say
 * so. pi leaves truncation to each tool; these are its limits (50KB / 2000
 * lines). The note names the transcript, never `get_subagent_result` — a
 * foreground caller holds no agent id to call it with (#174).
 */
export function capResult(text: string, outputFile?: string): string {
  const truncation = truncateHead(text);
  if (!truncation.truncated) return text;
  // truncateHead keeps whole lines only, so one oversized line leaves nothing.
  const kept = truncation.firstLineExceedsLimit ? text.slice(0, truncation.maxBytes) : truncation.content;
  const where = outputFile ? ` Full transcript: ${outputFile}` : "";
  return `${kept}\n\n[Result truncated: ${formatSize(Buffer.byteLength(kept))} of ${formatSize(truncation.totalBytes)}.${where}]`;
}
