/**
 * progress.ts — the workflow progress model, ported from Claude Code.
 *
 * Progress is an **append-only event log**, not a tree. Agent entries are keyed
 * by `index` and last-write-wins, so a running agent is updated by appending a
 * fresh entry with the same index rather than mutating anything. Every view —
 * the inline card, the workflows dialog, the widget — derives its shape
 * by collapsing that log. Keeping the log authoritative is what lets a batched
 * update carry several agents' changes in one message from the worker.
 *
 * Two vocabularies, deliberately distinct:
 *   - entry `state` is only start | done | error, with `skipped` and `cached`
 *     as separate booleans;
 *   - the display state adds queued, running, interrupted, skipped and failed,
 *     and is *derived* (see `displayState`).
 * Mixing them up is the easiest way to get the rendering wrong, which is why
 * the derivation lives here as one function rather than inline in each renderer.
 *
 * Everything in this file is pure and framework-free so the whole model is
 * unit-testable without a terminal.
 */

import type { WorkflowMeta, WorkflowPhaseMeta } from "./meta.ts";

/** Raw entry lifecycle, as written by the runtime. */
type WorkflowEntryState = "start" | "done" | "error";

/** Derived per-agent state, as rendered. */
export type WorkflowDisplayState =
  | "queued"
  | "running"
  | "done"
  | "failed"
  | "skipped"
  | "interrupted";

export interface WorkflowPhaseEntry {
  type: "workflow_phase";
  index: number;
  title: string;
}

export interface WorkflowLogEntry {
  type: "workflow_log";
  message: string;
}

export interface WorkflowAgentEntry {
  type: "workflow_agent";
  /** Stable identity. Re-emitting this index replaces the previous entry. */
  index: number;
  label: string;
  /**
   * Absent when the agent ran before any `phase()` call. That is the signal —
   * not a default of 0 — that turns the whole run into one "Agents" group.
   */
  phaseIndex?: number;
  phaseTitle?: string;
  state: WorkflowEntryState;
  agentId?: string;
  /**
   * The manager's `AgentRecord` id, once the child has one.
   *
   * Distinct from {@link agentId}, which is the run's own `wf-agent-N` handle
   * and means nothing outside the runtime. This is what the inspector's `c`
   * key opens a conversation viewer on, so it is reported the moment the
   * manager issues it rather than with the effective model — a child that dies
   * before its session resolves still has a conversation worth reading.
   */
  recordId?: string;
  agentType?: string;
  /**
   * Short model label for tight rows, e.g. `haiku 4.5`.
   *
   * Seeded from what the script asked for and then REPLACED by what the child
   * actually ran on, once its session exists to report one — the same
   * effective-not-requested rule every other subagent surface follows (#168).
   * An `agent()` that named no model therefore starts blank and fills in.
   */
  model?: string;
  /** Canonical `provider/model-id`, for the dialog, which has room for it. */
  modelId?: string;
  /** The level actually in effect, once the child's session reports one. */
  thinking?: string;
  /**
   * The level the call asked for, kept only when pi clamped it. Rendered as
   * `(asked max)` beside the effective value rather than silently replacing it.
   */
  requestedThinking?: string;
  isolation?: "worktree";
  error?: string;
  skipped?: boolean;
  cached?: boolean;
  queuedAt?: number;
  startedAt?: number;
  lastProgressAt?: number;
  attempt?: number;
  /** Why the agent is on a later attempt, shown next to its row. */
  lastAttemptReason?: "user-retry";
  promptPreview?: string;
  resultPreview?: string;
  tokens?: number;
  toolCalls?: number;
  durationMs?: number;
}

export type WorkflowEntry = WorkflowPhaseEntry | WorkflowLogEntry | WorkflowAgentEntry;

/** Overall run status, mirroring the task record. */
export type WorkflowRunStatus = "running" | "completed" | "failed" | "killed" | "paused";

interface CollapsedProgress {
  agents: WorkflowAgentEntry[];
  logs: string[];
  phaseTitles: Map<number, string>;
}

export interface PhaseGroup {
  title: string;
  status: "not-started" | "running" | "done" | "failed";
  agents: WorkflowAgentEntry[];
  doneCount: number;
  totalCount: number;
}

interface WorkflowStats {
  done: number;
  total: number;
  started: number;
}

/**
 * Fold the event log into its latest state.
 *
 * Agent entries collapse by index (last write wins); logs accumulate in order;
 * phase titles are a lookup for grouping.
 */
export function collapse(progress: readonly WorkflowEntry[]): CollapsedProgress {
  const agents = new Map<number, WorkflowAgentEntry>();
  const logs: string[] = [];
  const phaseTitles = new Map<number, string>();

  for (const entry of progress) {
    if (entry.type === "workflow_agent") agents.set(entry.index, entry);
    else if (entry.type === "workflow_log") logs.push(entry.message);
    else phaseTitles.set(entry.index, entry.title);
  }

  return {
    agents: [...agents.values()].sort((a, b) => a.index - b.index),
    logs,
    phaseTitles,
  };
}

/**
 * Derive what to render for one agent.
 *
 * `workflowActive` is false once the run has stopped: anything still mid-flight
 * at that point was cut off rather than finished, hence "interrupted".
 */
export function displayState(entry: WorkflowAgentEntry, workflowActive: boolean): WorkflowDisplayState {
  if (entry.state === "done") return "done";
  if (entry.state === "error") return entry.skipped ? "skipped" : "failed";
  if (!workflowActive) return "interrupted";
  // Queued means accepted but never given a slot. An entry with no queuedAt at
  // all predates the semaphore and is treated as running.
  return entry.queuedAt != null && entry.startedAt == null ? "queued" : "running";
}

/** Bucket agents by phase. Empty when no agent declared a phase. */
function groupByPhase(
  agents: readonly WorkflowAgentEntry[],
  phaseTitles: Map<number, string>,
): { phaseIndex: number; title: string; agents: WorkflowAgentEntry[] }[] {
  if (!agents.some(a => a.phaseIndex != null)) return [];

  const byPhase = new Map<number, { phaseIndex: number; title: string; agents: WorkflowAgentEntry[] }>();
  for (const agent of agents) {
    const phaseIndex = agent.phaseIndex ?? 0;
    let group = byPhase.get(phaseIndex);
    if (!group) {
      group = { phaseIndex, title: phaseTitles.get(phaseIndex) ?? `Phase ${phaseIndex}`, agents: [] };
      byPhase.set(phaseIndex, group);
    }
    group.agents.push(agent);
  }
  return [...byPhase.values()].sort((a, b) => a.phaseIndex - b.phaseIndex);
}

/** Roll a phase's agents up into the counts and totals its header shows. */
function summarize(group: { title: string; agents: WorkflowAgentEntry[] }): PhaseGroup {
  let done = 0;
  let failed = 0;

  for (const agent of group.agents) {
    if (agent.state === "done") done++;
    else if (agent.state === "error") failed++;
  }

  const total = group.agents.length;
  const finished = done + failed === total && total > 0;
  return {
    title: group.title,
    status: finished ? (failed > 0 ? "failed" : "done") : "running",
    agents: group.agents,
    doneCount: done,
    totalCount: total,
  };
}

const normalizeTitle = (title: string) => title.toLowerCase().trim();

/**
 * Reconcile the phases declared in `meta` with the phases actually observed.
 *
 * Matching is fuzzy on purpose: a script may call `phase("Review")` against a
 * declared `{ title: "Review changed files" }`, and Claude Code treats those as
 * the same phase when either title is a prefix of the other. Each observed
 * group is consumed at most once, declared-but-unseen phases render as
 * not-started placeholders, and observed groups with no declaration are
 * appended after — that is how an undeclared `phase()` "gets its own group".
 */
function mergePhases(
  declared: readonly WorkflowPhaseMeta[] | undefined,
  observed: { phaseIndex: number; title: string; agents: WorkflowAgentEntry[] }[],
): PhaseGroup[] {
  const consumed = new Set<{ phaseIndex: number; title: string; agents: WorkflowAgentEntry[] }>();
  const merged: PhaseGroup[] = [];

  for (const phase of declared ?? []) {
    const wanted = normalizeTitle(phase.title);
    const match = observed.find(group => {
      if (consumed.has(group)) return false;
      const actual = normalizeTitle(group.title);
      return actual === wanted || actual.startsWith(wanted) || wanted.startsWith(actual);
    });
    if (match) {
      consumed.add(match);
      merged.push(summarize(match));
    } else {
      merged.push({ title: phase.title, status: "not-started", agents: [], doneCount: 0, totalCount: 0 });
    }
  }

  for (const group of observed) {
    if (!consumed.has(group)) merged.push(summarize(group));
  }

  return merged;
}

/**
 * Build the phase groups a renderer walks.
 *
 * When nothing declared or emitted a phase, every agent collapses into a single
 * group titled "Agents" so the tree still has one level of structure.
 */
export function buildPhaseGroups(
  progress: readonly WorkflowEntry[],
  declared?: readonly WorkflowPhaseMeta[],
): PhaseGroup[] {
  const { agents, phaseTitles } = collapse(progress);
  const merged = mergePhases(declared, groupByPhase(agents, phaseTitles));
  if (merged.length === 0 && agents.length > 0) {
    return [summarize({ title: "Agents", agents })];
  }
  // A run that declared phases but produced un-phased agents would otherwise
  // render placeholders and drop those agents from the tree entirely. Claude
  // Code has the same hole; showing the work is worth the small divergence.
  if (agents.length > 0 && !merged.some(group => group.totalCount > 0)) {
    return [...merged, summarize({ title: "Agents", agents })];
  }
  return merged;
}

/**
 * Aggregate counts for the header line.
 *
 * `agentCount` is the number the runtime has *scheduled*, which can exceed the
 * number that has emitted an entry — a fan-out reports its size before its
 * agents start, so the total does not visibly climb as they trickle in.
 */
export function stats(progress: readonly WorkflowEntry[], agentCount = 0): WorkflowStats {
  let seen = 0;
  let done = 0;
  let started = 0;

  for (const entry of progress) {
    if (entry.type !== "workflow_agent") continue;
    seen++;
    if (entry.state === "done") done++;
    // Counted as started unless it is provably still waiting for a slot.
    if (entry.state !== "start" || entry.startedAt !== undefined || entry.queuedAt === undefined) started++;
  }

  return { done, total: Math.max(agentCount, seen), started };
}

/** Elapsed run time, excluding any time spent paused. */
export function elapsedMs(
  task: { startTime: number; endTime?: number; totalPausedMs?: number },
  now: number,
): number {
  return Math.max(0, (task.endTime ?? now) - task.startTime - (task.totalPausedMs ?? 0));
}

/** `1m12s` / `9s` / `340ms`, matching how the rest of the extension reads. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m${seconds.toString().padStart(2, "0")}s`;
}

interface WorkflowHeader {
  name: string;
  subtext: string;
  stats: string;
}

/**
 * The one-line summary above the tree: `3/7 agents · 1m12s`, plus a terminal
 * suffix once the run stops. Deliberately carries no phase count.
 */
export function header(
  task: {
    status: WorkflowRunStatus;
    workflowName?: string;
    startTime: number;
    endTime?: number;
    totalPausedMs?: number;
  },
  meta: WorkflowMeta | undefined,
  groups: readonly PhaseGroup[],
  agentCount: number,
  now: number,
): WorkflowHeader {
  const suffix =
    task.status === "completed" ? " · done"
    : task.status === "killed" ? " · stopped"
    : task.status === "paused" ? " · paused"
    : task.status === "failed" ? " · failed"
    : "";

  let doneAgents = 0;
  let totalAgents = 0;
  for (const group of groups) {
    doneAgents += group.doneCount;
    totalAgents += group.totalCount;
  }
  totalAgents = Math.max(agentCount, totalAgents, doneAgents);

  return {
    name: task.workflowName ?? meta?.name ?? "workflow",
    subtext: meta?.description ?? "",
    stats: `${doneAgents}/${totalAgents} ${totalAgents === 1 ? "agent" : "agents"} · ${formatDuration(elapsedMs(task, now))}${suffix}`,
  };
}

/* ------------------------------------------------------------------------- *
 * Size warning
 * ------------------------------------------------------------------------- */

const AGENT_CAP = 25;
const TOKEN_CAP = 1_500_000;
/** Assumed spend per agent before any has reported, for the projection. */
const ASSUMED_TOKENS_PER_AGENT = 70_000;

/**
 * Whether a run is about to get expensive.
 *
 * The projection matters more than the current total: a 200-agent fan-out is
 * worth flagging at agent 3, not after it has already spent the budget.
 */
export function sizeWarning(input: {
  scheduledAgents: number;
  startedAgents: number;
  totalTokens: number;
}): boolean {
  const perAgent = input.startedAgents > 0 ? input.totalTokens / input.startedAgents : ASSUMED_TOKENS_PER_AGENT;
  const projectedTokens = Math.max(input.totalTokens, Math.round(perAgent * input.scheduledAgents));
  return input.scheduledAgents > AGENT_CAP || projectedTokens > TOKEN_CAP;
}
