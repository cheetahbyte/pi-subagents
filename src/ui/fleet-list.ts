/**
 * fleet-list.ts — Claude Code-style "FleetView" full-screen agent picker.
 *
 * ← at an empty prompt opens a full-screen overlay grouping `main` plus every
 * retained top-level subagent by lifecycle state (capped at 30). Workflow runs
 * injected via `setWorkflowSource` sit above the agent groups: Enter on a run
 * opens the extension's inspector (never steering, never the native
 * transcript). ↑/↓ move the selection (filled ● marker), Enter swaps the native
 * transcript to the selected agent, and Esc returns to main. Older Pi versions
 * that cannot be patched fall back to the conversation overlay.
 *
 * Mechanics: all key handling goes through `onTerminalInput` — which fires
 * before the focused editor and can `consume` keys — gated on the editor
 * owning focus and `getEditorText() === ""` so normal typing is untouched.
 * The picker itself is a minimal `ctx.ui.custom` overlay component; pi routes
 * its keys straight to the component's `handleInput`.
 */

import { Editor, isKeyRelease, Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { hasAgentBadge, renderAgentName } from "../agent-color.js";
import { type AgentManager, isTopLevelAgent } from "../agent-manager.js";
import type { AgentRecord, ViewerMarkdownMode } from "../types.js";
import { getLifetimeCost, getLifetimeTotal } from "../usage.js";
import { type AgentActivity, formatCost, type Theme } from "./agent-widget.js";
import { ConversationViewer, VIEWPORT_HEIGHT_PCT } from "./conversation-viewer.js";
import { transcriptOverride } from "./transcript-override.js";

/** Max agent rows in the picker roster; older agents beyond this are dropped. */
const MAX_AGENTS = 30;
/** How long a settled workflow run lingers in the picker before it drops out. */
const FINISHED_LINGER_MS = 4000;

/** Minimal UI surface the picker needs from `ctx.ui` (structural subset). */
export type FleetUICtx = {
  onTerminalInput(handler: (data: string) => { consume?: boolean; data?: string } | undefined): () => void;
  getEditorText(): string;
  setEditorText?(text: string): void;
  notify(message: string, type?: "info" | "warning" | "error"): void;
  custom<T>(
    factory: (tui: any, theme: Theme, keybindings: any, done: (result: T) => void) => { render(width: number): string[]; invalidate(): void; dispose?(): void },
    options?: { overlay?: boolean; overlayOptions?: unknown; onHandle?: (handle: unknown) => void },
  ): Promise<T>;
};

/**
 * A workflow run, as the fleet list needs to see it.
 *
 * Narrow on purpose: the list knows nothing about `WorkflowTask`, the runtime
 * or the dialog, so it stays as testable as it was when it only held agents.
 * The extension maps its tasks into this shape and injects an opener.
 */
export interface FleetWorkflow {
  id: string;
  /** The `meta.name` of the run, or its id when the script named nothing. */
  name: string;
  status: "running" | "completed" | "failed" | "killed" | "paused";
  doneCount: number;
  totalCount: number;
  startedAt: number;
  /** Set once the run settles, which is what freezes its clock. */
  completedAt?: number;
  tokens: number;
}

type MainEntry = { kind: "main" };
type AgentEntry = { kind: "agent"; record: AgentRecord };
type WorkflowEntry = { kind: "workflow"; workflow: FleetWorkflow };
type FleetEntry = MainEntry | WorkflowEntry | AgentEntry;
type FleetGroup = "Queued" | "Running" | "Finished" | "Failed";

const GROUPS: FleetGroup[] = ["Queued", "Running", "Finished", "Failed"];

function fleetGroup(record: AgentRecord): FleetGroup {
  if (record.status === "queued") return "Queued";
  if (record.status === "running") return "Running";
  if (record.status === "completed" || record.status === "steered") return "Finished";
  return "Failed";
}

function entryId(entry: FleetEntry): string {
  return entry.kind === "main" ? "main" : entry.kind === "workflow" ? entry.workflow.id : entry.record.id;
}

/** What the picker overlay reports when it closes. */
type PickerOutcome =
  | { kind: "main" }                       // Esc, or Enter on `main` → native main transcript
  | { kind: "open"; record: AgentRecord }  // Enter on an agent → conversation viewer
  | { kind: "workflow"; workflow: FleetWorkflow }; // Enter on a run → extension's inspector

/** `11s` — integer seconds, no decimal/suffix (matches Claude Code, unlike formatMs). */
export function formatFleetElapsed(ms: number): string {
  return `${Math.max(0, Math.round(ms / 1000))}s`;
}

/** `↓ 13.1k tokens` — down-arrow prefix, compact magnitude, plural "tokens". */
export function formatFleetTokens(count: number): string {
  let compact: string;
  if (count >= 1_000_000) compact = `${(count / 1_000_000).toFixed(1)}M`;
  else if (count >= 1_000) compact = `${(count / 1_000).toFixed(1)}k`;
  else compact = `${count}`;
  return `↓ ${compact} tokens`;
}

/**
 * Place `right` flush to `width`, truncating `left` first so the stats survive.
 * The final clamp guarantees the line never exceeds `width` (which would wrap and
 * desync pi's line-diff → flicker) even on a terminal too narrow for the stats.
 */
function rightAlign(left: string, right: string, width: number): string {
  const rightW = visibleWidth(right);
  const maxLeft = Math.max(0, width - rightW - 1);
  const leftClamped = truncateToWidth(left, maxLeft);
  const gap = Math.max(1, width - visibleWidth(leftClamped) - rightW);
  return truncateToWidth(leftClamped + " ".repeat(gap) + right, width);
}

export class FleetList {
  private ui: FleetUICtx | undefined;
  /** Last tui seen (captured from an overlay factory) — used for the focus check. */
  private tui: any | undefined;
  private inputUnsub: (() => void) | undefined;

  private enabled = true;
  /** True while the picker or fallback conversation viewer is on screen. */
  private overlayOpen = false;
  /** 0 = `main`, 1..N = subagents. Seeds each picker; preserved across viewer round-trips. */
  private selectedIndex = 0;
  /** Set while a force-closed overlay's promise is pending — that close must not reopen anything. */
  private suppressReopen = false;
  /** Force-close handles for whichever overlay is currently open. */
  private pickerClose: (() => void) | undefined;
  private viewerClose: (() => void) | undefined;
  private viewingAgentId: string | undefined;
  /** Injected by the extension; absent until workflows are wired (or at all). */
  private workflowSource: (() => readonly FleetWorkflow[]) | undefined;
  private openWorkflow: ((id: string) => Promise<void> | void) | undefined;
  /**
   * Set while the workflow inspector is up.
   *
   * It does the two jobs `viewerClose` does for an agent's overlay — keep the
   * picker out of the dialog's keys, and remember which row to come back to —
   * minus the close handle, because that overlay belongs to the extension.
   */
  private viewingWorkflowId: string | undefined;

  constructor(
    private manager: AgentManager,
    private agentActivity: Map<string, AgentActivity>,
    /**
     * Read when the picker opens. Whether each row shows an estimated cost after
     * its token count. Defaults to off — the extension supplies the user's
     * `showCost` setting.
     */
    private showCost: () => boolean = () => false,
    /**
     * The user's `viewerMarkdown` setting, for a conversation overlay opened
     * from here. Read live rather than captured, because the viewer's `m` key
     * changes it while the overlay is up. Omitted → the viewer's own default.
     */
    private viewerMarkdown?: () => ViewerMarkdownMode,
    /**
     * Persist a mode chosen with `m` in that overlay, so the key means the same
     * thing here as it does from `/agents` — one setting, not one per entry
     * point. Omitted → `m` still cycles, viewer-locally.
     */
    private onViewerMarkdown?: (mode: ViewerMarkdownMode) => void,
  ) {}

  // ---- Lifecycle ----

  setEnabled(enabled: boolean): void {
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    if (!enabled) {
      transcriptOverride.clear();
      this.viewingAgentId = undefined;
      this.closeOverlay();
      if (this.viewingWorkflowId !== undefined) {
        // The inspector belongs to the extension — no handle to close — but its
        // settle promise must not reopen the picker while disabled.
        this.suppressReopen = true;
        this.viewingWorkflowId = undefined;
      }
    }
  }

  /** Capture the UI context and (re)register the global input handler. */
  setUICtx(ui: FleetUICtx): void {
    if (ui === this.ui) return;
    this.inputUnsub?.();
    this.ui = ui;
    this.tui = undefined;
    this.inputUnsub = ui.onTerminalInput(data => this.handleKey(data));
  }

  /** Kept for the extension's spawn hooks — the picker re-renders on input, no timer. */
  ensureTimer(): void {}
  /** Kept for the extension's refresh hooks — the roster is read live at render time. */
  update(): void {}
  /** Kept for the extension's completion hook — the viewer stays open on its own. */
  onAgentFinished(_id: string): void {}

  dispose(): void {
    transcriptOverride.clear();
    this.inputUnsub?.();
    this.inputUnsub = undefined;
    this.closeOverlay();
    this.viewingAgentId = undefined;
    // No handle to close the workflow inspector with, but the list is going
    // away — leaving the id set would keep it swallowing input forever.
    this.viewingWorkflowId = undefined;
    this.tui = undefined;
    this.selectedIndex = 0;
    // Null last so the overlay-close microtask can't reach a live ui.
    this.ui = undefined;
  }

  /** Close whichever overlay is up (disable/dispose) without reopening anything. */
  private closeOverlay(): void {
    const close = this.viewerClose ?? this.pickerClose;
    this.suppressReopen = close !== undefined;
    this.overlayOpen = false;
    this.viewerClose = undefined;
    this.pickerClose = undefined;
    close?.();
  }

  // ---- Workflow source ----

  /**
   * Wire workflow runs into the picker.
   *
   * Injected rather than constructed here because the fleet list predates
   * workflows and must keep working without them — a session with the feature
   * switched off never calls this, and the roster is agents-only exactly as
   * before.
   */
  setWorkflowSource(
    source: () => readonly FleetWorkflow[],
    open: (id: string) => Promise<void> | void,
  ): void {
    this.workflowSource = source;
    this.openWorkflow = open;
  }

  /** Live runs, plus recently settled ones — a settled run lingers briefly before dropping out. */
  private workflows(): FleetWorkflow[] {
    if (!this.workflowSource) return [];
    const now = Date.now();
    return [...this.workflowSource()]
      .filter(run =>
        run.status === "running"
        || run.status === "paused"
        || (run.completedAt != null && now - run.completedAt < FINISHED_LINGER_MS)
      )
      .sort((a, b) => a.startedAt - b.startedAt);
  }

  // ---- Roster ----

  /**
   * Agents offered by the picker: every retained top-level record, newest first
   * within its lifecycle group. Queued records may not have a session yet, so
   * they are visible but not openable. Tombstones (evicted records) are only
   * reachable via `listTombstones()` and never appear here; children owned by
   * an agent or workflow are hidden behind their owner. Capped so the picker
   * stays responsive on long sessions.
   */
  private agentRecords(): AgentRecord[] {
    return this.manager.listAgents()
      .filter(a => isTopLevelAgent(a))
      .slice(0, MAX_AGENTS);
  }

  /**
   * Runs sit above the agent groups rather than interleaved by start time: a
   * run owns most of the agents under it, so listing the container first is
   * what makes the picker read as a hierarchy rather than a shuffle.
   */
  private roster(): FleetEntry[] {
    const records = this.agentRecords();
    return [
      { kind: "main" },
      ...this.workflows().map(workflow => ({ kind: "workflow" as const, workflow })),
      ...GROUPS.flatMap(group => records
        .filter(record => fleetGroup(record) === group)
        .map(record => ({ kind: "agent" as const, record }))),
    ];
  }

  private clampSelection(): void {
    const max = this.roster().length - 1;
    if (this.selectedIndex > max) this.selectedIndex = Math.max(0, max);
    if (this.selectedIndex < 0) this.selectedIndex = 0;
  }

  // ---- Key handling ----

  /** Returns `{consume:true}` to swallow a key, or undefined to let it through. */
  handleKey(data: string): { consume?: boolean; data?: string } | undefined {
    if (!this.enabled || !this.ui) return undefined;
    // Input listeners receive BOTH key-press and key-release (the kitty protocol
    // emits both, and matchesKey matches either) — act on press only.
    if (isKeyRelease(data)) return undefined;
    // While an overlay is open, it owns all input. Checked before the focus
    // test below, which would otherwise read the dialog holding the keyboard as
    // "the user left the prompt" and reset the selection out from under it.
    // The workflow inspector has no overlay of ours (the extension owns it),
    // so it is gated the same way by id.
    if (this.overlayOpen || this.viewingWorkflowId) return undefined;
    // Input listeners fire BEFORE the focused component, and dialogs
    // (ctx.ui.select/confirm/input, pi's own menus) swap the prompt editor out
    // while getEditorText() still reads the detached — empty — editor. So when
    // anything but the editor owns the keyboard, stay out of its keys (#123).
    if (!this.editorHasFocus()) return undefined;

    const editorText = this.ui.getEditorText();
    if (this.viewingAgentId) {
      if (matchesKey(data, "escape") && editorText === "") {
        transcriptOverride.clear();
        this.viewingAgentId = undefined;
        this.selectedIndex = 0;
        return { consume: true };
      }
      if (matchesKey(data, Key.enter)) {
        const message = editorText.trim();
        if (message.startsWith("/") || message.startsWith("@")) {
          transcriptOverride.clear();
          this.viewingAgentId = undefined;
          this.selectedIndex = 0;
          return undefined;
        }
        if (message && this.manager.steer(this.viewingAgentId, message)) this.ui.setEditorText?.("");
        else if (message) this.ui.notify("This agent can no longer be steered.", "warning");
        return { consume: true };
      }
    }

    // ← at an empty prompt opens the picker; every other key flows to the editor.
    if (matchesKey(data, "left") && editorText === "") {
      this.openPicker();
      return { consume: true };
    }
    return undefined;
  }

  /**
   * True when pi's prompt editor owns the keyboard. pi's editor is an `Editor`
   * subclass (CustomEditor) while every dialog/selector is not, and the loader
   * aliases pi-tui to pi's own copy, so `instanceof` is a reliable identity
   * check. `focusedComponent` is TUI-private (no public accessor), hence the
   * best-effort peek: unknowable focus (no tui seen yet, nothing focused)
   * counts as the editor so activation keeps working.
   */
  private editorHasFocus(): boolean {
    const focused = (this.tui as { focusedComponent?: unknown } | undefined)?.focusedComponent;
    return focused == null || focused instanceof Editor;
  }

  // ---- Overlay flow ----

  /** Open the full-screen picker overlay (from ← at an empty prompt). */
  private openPicker(): void {
    if (!this.ui || this.overlayOpen) return;
    this.clampSelection();
    this.overlayOpen = true;
    // The roster is read live at render time so a finishing agent's row drops
    // out without a timer. `showCost` is read once, like the viewer's.
    const initialIndex = this.selectedIndex;
    const showCost = this.showCost();
    void this.ui.custom<PickerOutcome>(
      (tui, theme, _keybindings, done) => {
        this.tui = tui;
        this.pickerClose = () => done({ kind: "main" });
        return new FleetPicker(tui, theme, {
          getRoster: () => this.roster(),
          initialIndex,
          showCost,
          done,
        });
      },
      {
        overlay: true,
        overlayOptions: { anchor: "top-center", width: "100%", maxHeight: "100%", margin: 0 },
      },
    ).then(
      outcome => this.pickerClosed(outcome),
      () => this.pickerClosed({ kind: "main" }), // error → just land on main, nothing to reopen
    );
  }

  /** Picker closed: `main` ends the flow; an agent hands off to its viewer; a run to its inspector. */
  private pickerClosed(outcome: PickerOutcome): void {
    this.pickerClose = undefined;
    this.overlayOpen = false;
    if (this.suppressReopen) { this.suppressReopen = false; return; }
    if (outcome.kind === "main") {
      transcriptOverride.clear();
      this.viewingAgentId = undefined;
      this.selectedIndex = 0; // fresh start next time
      return;
    }
    if (outcome.kind === "workflow") {
      this.openWorkflowInspector(outcome.workflow);
      return;
    }
    const index = this.roster().findIndex(entry => entry.kind === "agent" && entry.record.id === outcome.record.id);
    if (index >= 0) this.selectedIndex = index;
    this.openViewer(outcome.record);
  }

  /**
   * Open the extension-owned workflow inspector.
   *
   * No close handle — the extension's dialog owns its own overlay and closes
   * it, and its promise resolves when it comes down — but the picker still has
   * to know one is up (its keys must not leak to the prompt) and still has to
   * put the cursor back on the run when it closes. The native child transcript
   * (and the agent id that drives it) is dropped first so the inspector reads
   * only what it opens, and nothing of the child's session survives the trip.
   */
  private openWorkflowInspector(workflow: FleetWorkflow): void {
    if (!this.ui || !this.openWorkflow) return;
    transcriptOverride.clear();
    this.viewingAgentId = undefined;
    this.viewingWorkflowId = workflow.id;
    void Promise.resolve(this.openWorkflow(workflow.id)).then(
      () => this.workflowInspectorClosed(),
      () => this.workflowInspectorClosed(),
    );
  }

  /**
   * Inspector closed (the extension called its dialog's done) — reopen the
   * picker with the selection on the run we were inspecting. Re-resolve by id
   * so it still lands right if the roster reordered while the dialog was up.
   * A disable/dispose consumed `suppressReopen` instead: nothing reopens, and
   * the flag is spent so the next picker works normally.
   */
  private workflowInspectorClosed(): void {
    const inspected = this.viewingWorkflowId;
    this.viewingWorkflowId = undefined;
    if (this.suppressReopen) { this.suppressReopen = false; return; }
    if (inspected !== undefined) {
      const idx = this.roster().findIndex(entry => entry.kind === "workflow" && entry.workflow.id === inspected);
      if (idx >= 0) this.selectedIndex = idx;
    }
    this.openPicker();
  }

  /**
   * Open the agent's conversation viewer. The picker is already closed — its
   * `done` ran before this promise callback — so the overlays never stack.
   */
  private openViewer(record: AgentRecord): void {
    if (!this.ui || !record.session) return;
    if (this.ui.setEditorText && transcriptOverride.show(record.session)) {
      this.viewingAgentId = record.id;
      return;
    }
    this.overlayOpen = true;
    this.viewingAgentId = record.id;
    const session = record.session;
    const activity = this.agentActivity.get(record.id);
    void this.ui.custom<undefined>(
      (tui, theme, keybindings, done) => {
        this.viewerClose = () => done(undefined);
        return new ConversationViewer(
          tui,
          session,
          record,
          activity,
          theme,
          done,
          () => {
            if (this.manager.abort(record.id)) this.ui?.notify(`Stopped "${record.description}".`, "info");
          },
          keybindings,
          (message: string) => this.manager.steer(record.id, message),
          this.showCost(),
          this.viewerMarkdown,
          this.onViewerMarkdown,
        );
      },
      {
        overlay: true,
        overlayOptions: { anchor: "center", width: "90%", maxHeight: `${VIEWPORT_HEIGHT_PCT}%` },
      },
    ).then(() => this.viewerClosed(), () => this.viewerClosed());
  }

  /**
   * Viewer closed (Esc) — reopen the picker with the selection on the agent we
   * were viewing. Re-resolve by id so it still lands right if the roster
   * reordered while the overlay was up; if the agent is gone, keep the index
   * and let the picker's clamp settle it.
   */
  private viewerClosed(): void {
    this.viewerClose = undefined;
    this.overlayOpen = false;
    if (this.suppressReopen) { this.suppressReopen = false; return; }
    if (this.viewingAgentId) {
      const idx = this.roster().findIndex(e => e.kind === "agent" && e.record.id === this.viewingAgentId);
      if (idx >= 0) this.selectedIndex = idx;
    }
    this.viewingAgentId = undefined;
    this.openPicker();
  }
}

/**
 * Full-screen picker overlay. Minimal by design: navigation state lives here,
 * and FleetList re-seeds it after a viewer round-trip. pi routes keys to the
 * focused overlay component (key releases are filtered unless the component
 * opts in via `wantsKeyRelease`) and calls `render()` with the overlay width.
 */
class FleetPicker {
  private selectedId: string;

  constructor(
    private tui: any,
    private theme: Theme,
    private deps: {
      getRoster: () => FleetEntry[];
      initialIndex: number;
      showCost: boolean;
      done: (outcome: PickerOutcome) => void;
    },
  ) {
    this.selectedId = entryId(deps.getRoster()[deps.initialIndex] ?? { kind: "main" });
  }

  handleInput(data: string): void {
    // Defensive: pi already filters releases for components, but a release must
    // never be treated as a press here either.
    if (isKeyRelease(data)) return;
    const roster = this.deps.getRoster();
    let index = roster.findIndex(entry => entryId(entry) === this.selectedId);
    if (index < 0) index = 0;
    if (matchesKey(data, "down")) {
      index = Math.min(roster.length - 1, index + 1);
      this.selectedId = entryId(roster[index]);
      this.tui.requestRender();
    } else if (matchesKey(data, "up")) {
      index = Math.max(0, index - 1);
      this.selectedId = entryId(roster[index]);
      this.tui.requestRender();
    } else if (matchesKey(data, "escape")) {
      this.deps.done({ kind: "main" });
    } else if (matchesKey(data, Key.enter)) {
      const entry = roster[index];
      if (entry?.kind === "main") this.deps.done({ kind: "main" });
      else if (entry?.kind === "agent" && entry.record.session) this.deps.done({ kind: "open", record: entry.record });
      else if (entry?.kind === "workflow") this.deps.done({ kind: "workflow", workflow: entry.workflow });
    }
  }

  render(width: number): string[] {
    const rows = Math.max(1, this.tui.terminal.rows ?? 1);
    const roster = this.deps.getRoster();
    let sel = roster.findIndex(entry => entryId(entry) === this.selectedId);
    if (sel < 0) {
      sel = 0;
      this.selectedId = "main";
    }
    const th = this.theme;
    const display: Array<{ entry?: FleetEntry; rosterIndex?: number; text?: string }> = [
      { entry: roster[0], rosterIndex: 0 },
    ];
    // Workflows form their own section above the agent groups: a run owns most
    // of the agents under it, so the container comes first.
    const workflows = roster
      .map((entry, rosterIndex) => ({ entry, rosterIndex }))
      .filter(item => item.entry.kind === "workflow");
    if (workflows.length > 0) {
      display.push({ text: `  ${th.fg("dim", `Workflows (${workflows.length})`)}` }, ...workflows);
    }
    for (const group of GROUPS) {
      const entries = roster
        .map((entry, rosterIndex) => ({ entry, rosterIndex }))
        .filter(item => item.entry.kind === "agent" && fleetGroup(item.entry.record) === group);
      display.push({ text: `  ${th.fg("dim", `${group} (${entries.length})`)}` }, ...entries);
    }
    const selectedLine = display.findIndex(line => line.rosterIndex === sel);
    // Hint + blank separator top the list; the terminal height bounds the rest.
    const header = rows >= 3 ? 2 : 1;
    const budget = Math.max(0, rows - header);
    let visible = Math.min(display.length, budget);
    let start = selectedLine < visible ? 0 : selectedLine - visible + 1;
    let below = display.length - (start + visible);
    // The window plus its "↑ N more"/"↓ N more" indicators must fit the budget —
    // shrink (and re-center) until they do.
    while (visible > 0 && visible + (start > 0 ? 1 : 0) + (below > 0 ? 1 : 0) > budget) {
      visible -= 1;
      start = selectedLine < visible ? 0 : selectedLine - visible + 1;
      below = display.length - (start + visible);
    }

    const lines: string[] = [
      truncateToWidth(`  ${th.fg("dim", "↑↓ select · enter view · esc close")}`, width),
    ];
    if (header === 2) lines.push("");
    if (start > 0) lines.push(rightAlign("", th.fg("dim", `↑ ${start} more`), width));
    for (let r = start; r < start + visible; r++) {
      const line = display[r];
      lines.push(line.entry && line.rosterIndex !== undefined
        ? this.row(line.rosterIndex, sel, line.entry, width)
        : truncateToWidth(line.text ?? "", width));
    }
    if (below > 0) lines.push(rightAlign("", th.fg("dim", `↓ ${below} more`), width));
    // Fill the rest of the screen so the overlay covers the terminal.
    while (lines.length < rows) lines.push("");
    return lines.slice(0, rows);
  }

  invalidate(): void { /* no cached state to clear */ }
  dispose(): void { /* no subscriptions */ }

  // ---- Rendering ----

  private row(rosterIndex: number, sel: number, entry: FleetEntry, width: number): string {
    if (entry.kind === "main") {
      return truncateToWidth(`  ${this.bullet(rosterIndex, sel)} main`, width);
    }
    if (entry.kind === "workflow") {
      return this.workflowRow(rosterIndex, sel, entry.workflow, width);
    }
    return this.agentRow(rosterIndex, sel, entry.record, width);
  }

  private bullet(rosterIndex: number, sel: number): string {
    const th = this.theme;
    return rosterIndex === sel ? th.fg("accent", "●") : th.fg("dim", "○");
  }

  /**
   * A run's row. Shaped like an agent's — bullet, kind, name, stats flush right
   * — so the two read as one list, with the agent count where an agent has its
   * description and the same elapsed/token tail.
   */
  private workflowRow(rosterIndex: number, sel: number, workflow: FleetWorkflow, width: number): string {
    const th = this.theme;
    const selected = rosterIndex === sel;
    const kind = th.fg(selected ? "text" : "muted", "workflow");
    const name = selected ? th.fg("text", workflow.name) : workflow.name;
    const left = `  ${this.bullet(rosterIndex, sel)} ${kind}  ${name}`;
    // Frozen once the run settles, exactly as an agent's clock is.
    const elapsed = (workflow.completedAt ?? Date.now()) - workflow.startedAt;
    const agents = `${workflow.doneCount}/${workflow.totalCount} agent${workflow.totalCount === 1 ? "" : "s"}`;
    const stats = `${agents} · ${formatFleetElapsed(elapsed)} · ${formatFleetTokens(workflow.tokens)}`;
    return rightAlign(left, selected ? th.fg("text", stats) : th.fg("dim", stats), width);
  }

  private agentRow(rosterIndex: number, sel: number, record: AgentRecord, width: number): string {
    const th = this.theme;
    // The selected row renders in the theme's primary text color so it reads as
    // one selection (#230). A configured badge survives — Claude Code's FleetView
    // keeps the agent color on the selected row too and only bolds it — which also
    // keeps the row's width fixed as the selection moves.
    const selected = rosterIndex === sel;
    const name = renderAgentName(record.type, th, selected
      ? { fallbackColor: "text", bold: hasAgentBadge(record.type) }
      : { fallbackColor: "muted" });
    const description = selected ? th.fg("text", record.description) : record.description;
    const left = `  ${this.bullet(rosterIndex, sel)} ${name}  ${description}`;
    // The record, not the activity tracker — see the note in AgentWidget's
    // running line: only the record carries a nested child's spend, and only it
    // outlives the agent.
    const tokens = getLifetimeTotal(record.lifetimeUsage);
    const elapsedMs = (record.completedAt ?? Date.now()) - record.startedAt; // freezes once finished
    const cost = this.deps.showCost ? formatCost(getLifetimeCost(record.lifetimeUsage)) : "";
    const stats = `${formatFleetElapsed(elapsedMs)} · ${formatFleetTokens(tokens)}${cost ? ` · ${cost}` : ""}`;
    const right = selected ? th.fg("text", stats) : th.fg("dim", stats);
    return rightAlign(left, right, width);
  }
}