/**
 * fleet-list.ts — Claude Code-style "FleetView" full-screen agent picker.
 *
 * ← at an empty prompt opens a full-screen overlay listing `main` plus every
 * retained top-level subagent that has a session (newest first, capped at 30).
 * ↑/↓ move the selection (filled ● marker), Enter opens the selected agent's
 * live conversation overlay, Esc (or Enter on `main`) returns to the native
 * main transcript. A viewer stays open when its agent finishes; Esc from the
 * viewer returns to the picker with the selection preserved.
 *
 * Mechanics: all key handling goes through `onTerminalInput` — which fires
 * before the focused editor and can `consume` keys — gated on the editor
 * owning focus and `getEditorText() === ""` so normal typing is untouched.
 * The picker itself is a minimal `ctx.ui.custom` overlay component; pi routes
 * its keys straight to the component's `handleInput`.
 */

import { Editor, isKeyRelease, Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { hasAgentBadge, renderAgentName } from "../agent-color.js";
import type { AgentManager } from "../agent-manager.js";
import type { AgentRecord } from "../types.js";
import { getLifetimeCost, getLifetimeTotal } from "../usage.js";
import { type AgentActivity, formatCost, type Theme } from "./agent-widget.js";
import { ConversationViewer, VIEWPORT_HEIGHT_PCT } from "./conversation-viewer.js";

/** Max agent rows in the picker roster; older agents beyond this are dropped. */
const MAX_AGENTS = 30;

/** Minimal UI surface the picker needs from `ctx.ui` (structural subset). */
export type FleetUICtx = {
  onTerminalInput(handler: (data: string) => { consume?: boolean; data?: string } | undefined): () => void;
  getEditorText(): string;
  notify(message: string, type?: "info" | "warning" | "error"): void;
  custom<T>(
    factory: (tui: any, theme: Theme, keybindings: any, done: (result: T) => void) => { render(width: number): string[]; invalidate(): void; dispose?(): void },
    options?: { overlay?: boolean; overlayOptions?: unknown; onHandle?: (handle: unknown) => void },
  ): Promise<T>;
};

type MainEntry = { kind: "main" };
type AgentEntry = { kind: "agent"; record: AgentRecord };
type FleetEntry = MainEntry | AgentEntry;

/** What the picker overlay reports when it closes. */
type PickerOutcome =
  | { kind: "main" }                       // Esc, or Enter on `main` → native main transcript
  | { kind: "open"; record: AgentRecord }; // Enter on an agent → conversation viewer

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
  /** True while the picker or a conversation viewer overlay is on screen. */
  private overlayOpen = false;
  /** 0 = `main`, 1..N = subagents. Seeds each picker; preserved across viewer round-trips. */
  private selectedIndex = 0;
  /** Set while a force-closed overlay's promise is pending — that close must not reopen anything. */
  private suppressReopen = false;
  /** Force-close handles for whichever overlay is currently open. */
  private pickerClose: (() => void) | undefined;
  private viewerClose: (() => void) | undefined;
  private viewingAgentId: string | undefined;

  constructor(
    private manager: AgentManager,
    private agentActivity: Map<string, AgentActivity>,
    /**
     * Read when the picker opens. Whether each row shows an estimated cost after
     * its token count. Defaults to off — the extension supplies the user's
     * `showCost` setting.
     */
    private showCost: () => boolean = () => false,
  ) {}

  // ---- Lifecycle ----

  setEnabled(enabled: boolean): void {
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    if (!enabled) this.closeOverlay();
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
    this.inputUnsub?.();
    this.inputUnsub = undefined;
    this.closeOverlay();
    this.viewingAgentId = undefined;
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

  // ---- Roster ----

  /**
   * Agents offered by the picker: every retained top-level record that still
   * has a session, newest first (the manager already sorts `listAgents()` that
   * way). Retained covers all statuses — running, queued, finished, stopped —
   * so a completed agent stays openable. Tombstones (evicted records) are only
   * reachable via `listTombstones()` and never appear here; nested children are
   * owned by their parent's thread and hidden. Capped so the picker stays
   * responsive on long sessions.
   */
  private agentRecords(): AgentRecord[] {
    return this.manager.listAgents()
      .filter(a => !a.parentAgentId && a.session)
      .slice(0, MAX_AGENTS);
  }

  private roster(): FleetEntry[] {
    return [{ kind: "main" }, ...this.agentRecords().map(record => ({ kind: "agent" as const, record }))];
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
    // While an overlay is open, it owns all input.
    if (this.overlayOpen) return undefined;
    // Input listeners fire BEFORE the focused component, and dialogs
    // (ctx.ui.select/confirm/input, pi's own menus) swap the prompt editor out
    // while getEditorText() still reads the detached — empty — editor. So when
    // anything but the editor owns the keyboard, stay out of its keys (#123).
    if (!this.editorHasFocus()) return undefined;

    // ← at an empty prompt opens the picker; every other key flows to the editor.
    if (matchesKey(data, "left") && this.ui.getEditorText() === "") {
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

  /** Picker closed: `main` ends the flow; an agent hands off to its viewer. */
  private pickerClosed(outcome: PickerOutcome): void {
    this.pickerClose = undefined;
    this.overlayOpen = false;
    if (this.suppressReopen) { this.suppressReopen = false; return; }
    if (outcome.kind === "main") {
      this.selectedIndex = 0; // fresh start next time
      return;
    }
    this.openViewer(outcome.record);
  }

  /**
   * Open the agent's conversation viewer. The picker is already closed — its
   * `done` ran before this promise callback — so the overlays never stack.
   */
  private openViewer(record: AgentRecord): void {
    if (!this.ui || !record.session) return;
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
  private index: number;

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
    this.index = deps.initialIndex;
  }

  handleInput(data: string): void {
    // Defensive: pi already filters releases for components, but a release must
    // never be treated as a press here either.
    if (isKeyRelease(data)) return;
    const roster = this.deps.getRoster();
    if (matchesKey(data, "down")) {
      this.index = Math.min(roster.length - 1, this.index + 1);
      this.tui.requestRender();
    } else if (matchesKey(data, "up")) {
      this.index = Math.max(0, this.index - 1);
      this.tui.requestRender();
    } else if (matchesKey(data, "escape")) {
      this.deps.done({ kind: "main" });
    } else if (matchesKey(data, Key.enter)) {
      const entry = roster[this.index];
      if (entry?.kind === "main") this.deps.done({ kind: "main" });
      else if (entry?.kind === "agent") this.deps.done({ kind: "open", record: entry.record });
    }
  }

  render(width: number): string[] {
    const rows = Math.max(1, this.tui.terminal.rows ?? 1);
    const roster = this.deps.getRoster();
    const sel = Math.min(this.index, roster.length - 1);
    const th = this.theme;
    // Hint + blank separator top the list; the terminal height bounds the rest.
    const header = rows >= 3 ? 2 : 1;
    const budget = Math.max(0, rows - header);
    let visible = Math.min(roster.length, budget);
    let start = sel < visible ? 0 : sel - visible + 1;
    let below = roster.length - (start + visible);
    // The window plus its "↑ N more"/"↓ N more" indicators must fit the budget —
    // shrink (and re-center) until they do.
    while (visible > 0 && visible + (start > 0 ? 1 : 0) + (below > 0 ? 1 : 0) > budget) {
      visible -= 1;
      start = sel < visible ? 0 : sel - visible + 1;
      below = roster.length - (start + visible);
    }

    const lines: string[] = [
      truncateToWidth(`  ${th.fg("dim", "↑↓ select · enter view · esc close")}`, width),
    ];
    if (header === 2) lines.push("");
    if (start > 0) lines.push(rightAlign("", th.fg("dim", `↑ ${start} more`), width));
    for (let r = start; r < start + visible; r++) {
      lines.push(this.row(r, sel, roster[r], width));
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
    return this.agentRow(rosterIndex, sel, entry.record, width);
  }

  private bullet(rosterIndex: number, sel: number): string {
    const th = this.theme;
    return rosterIndex === sel ? th.fg("accent", "●") : th.fg("dim", "○");
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