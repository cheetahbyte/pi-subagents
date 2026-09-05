import { Editor, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import type { AgentManager } from "../src/agent-manager.js";
import { registerAgents } from "../src/agent-types.js";
import type { AgentConfig, AgentRecord, ViewerMarkdownMode } from "../src/types.js";
import { type AgentActivity, getDisplayName } from "../src/ui/agent-widget.js";
import {
  FleetList,
  type FleetUICtx,
  type FleetWorkflow,
  formatFleetElapsed,
  formatFleetTokens,
} from "../src/ui/fleet-list.js";
import { transcriptOverride } from "../src/ui/transcript-override.js";

// ---- Key sequences (see node_modules/@earendil-works/pi-tui/dist/keys.js) ----
const DOWN = "\x1b[B";
const UP = "\x1b[A";
const LEFT = "\x1b[D";
const RIGHT = "\x1b[C";
const ESC = "\x1b";
const ENTER = "\r";
// Kitty-protocol key-RELEASE events (event type 3) — listeners receive these too.
const LEFT_RELEASE = "\x1b[1;1:3D";
const DOWN_RELEASE = "\x1b[1;1:3B";

const theme = { fg: (c: string, s: string) => `<${c}>${s}</${c}>`, bold: (s: string) => `*${s}*` };

/** An agent that renders as a badge — no default agent configures a color. */
const BADGED_TYPE = "colored-reviewer";
const PURPLE_BACKGROUND = "\u001b[48;2;130;125;189m";
const BADGED_CONFIG: AgentConfig = {
  name: BADGED_TYPE,
  displayName: "Code Reviewer",
  color: "purple",
  description: "Reviews code",
  extensions: false,
  skills: false,
  systemPrompt: "Review code.",
  promptMode: "replace",
};

/**
 * Visible text of a rendered row: ANSI stripped, along with this theme's fake
 * `<color>` / `*bold*` markers — all three stand in for zero-width escapes.
 */
function plain(row: string): string {
  return row.replace(/\u001b\[[0-9;]*m/g, "").replace(/<\/?[a-zA-Z]+>|\*/g, "");
}

/** A no-op session so a record is "openable" by default (the picker hides session-less agents). */
const FAKE_SESSION = { subscribe: () => () => {}, messages: [] };

function makeRecord(over: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: "a1",
    type: "general-purpose",
    description: "Sleep then report 1",
    status: "running",
    toolUses: 0,
    startedAt: Date.now(),
    session: FAKE_SESSION as any,
    lifetimeUsage: { input: 13100, output: 0, cacheWrite: 0 },
    compactionCount: 0,
    ...over,
  } as AgentRecord;
}

function makeWorkflow(over: Partial<FleetWorkflow> = {}): FleetWorkflow {
  return {
    id: "wf_abc123",
    name: "audit-src",
    status: "running",
    doneCount: 1,
    totalCount: 3,
    startedAt: Date.now() - 32_000,
    tokens: 26_400,
    ...over,
  };
}

/** Fake manager exposing only what FleetList touches. */
function fakeManager(agents: AgentRecord[]): AgentManager {
  return {
    listAgents: () => agents,
    abort: vi.fn(() => true),
    steer: vi.fn(() => true),
  } as unknown as AgentManager;
}

const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

interface Overlay {
  component: { handleInput(data: string): void; render(w: number): string[] };
  done: ((r: any) => void) | undefined;
  closed: boolean;
}

interface Harness {
  fleet: FleetList;
  ui: FleetUICtx;
  manager: AgentManager;
  /** Replace the workflow runs the picker sees. */
  setWorkflows: (list: FleetWorkflow[]) => void;
  /** Ids the picker asked the extension to open, in order. */
  openedWorkflows: () => string[];
  /** Settle the workflow inspector the picker last opened; flushes the close microtask. */
  closeWorkflowDialog: () => Promise<void>;
  /** Feed a key to the registered input handler; returns the consume result. */
  press: (data: string) => { consume?: boolean } | undefined;
  setEditorText: (t: string) => void;
  /** The currently open overlay (picker or viewer), or undefined. */
  overlay: () => Overlay | undefined;
  /** How many overlays have been opened in total (picker reopens push new ones). */
  overlayCount: () => number;
  /** Render the currently open overlay at the given width. */
  render: (width?: number) => string[];
  /** Drive a key into the open overlay's handleInput (pi routes its keys there). */
  overlayKey: (data: string) => void;
  /** The fake `tui` handed to overlay factories; tests set `focusedComponent` on it. */
  tui: { requestRender(): void; focusedComponent?: unknown; terminal: { columns: number; rows: number } };
}

function harness(
  agents: AgentRecord[],
  opts: {
    viewerMarkdown?: () => ViewerMarkdownMode;
    onViewerMarkdown?: (mode: ViewerMarkdownMode) => void;
  } = {},
): Harness {
  let inputHandler: ((data: string) => { consume?: boolean } | undefined) | undefined;
  let editorText = "";
  const overlays: Overlay[] = [];
  const fakeTui = { requestRender: () => {}, terminal: { columns: 120, rows: 40 } };

  const ui: FleetUICtx = {
    onTerminalInput: (h) => { inputHandler = h; return () => { inputHandler = undefined; }; },
    getEditorText: () => editorText,
    setEditorText: (t) => { editorText = t; },
    notify: () => {},
    custom: ((factory: any) => {
      return new Promise<any>((resolve) => {
        const overlay: Overlay = { done: undefined as any, closed: false, component: undefined as any };
        overlay.done = (r: any) => { overlay.closed = true; overlay.done = undefined; resolve(r); };
        overlay.component = factory(fakeTui, theme, undefined, overlay.done);
        overlays.push(overlay);
      });
    }) as FleetUICtx["custom"],
  };

  const manager = fakeManager(agents);
  const fleet = new FleetList(manager, new Map(), undefined, opts.viewerMarkdown, opts.onViewerMarkdown);
  fleet.setUICtx(ui);
  let workflows: FleetWorkflow[] = [];
  const openedWorkflows: string[] = [];
  let closeWorkflowDialog: (() => void) | undefined;
  fleet.setWorkflowSource(() => workflows, id => {
    openedWorkflows.push(id);
    // The real opener hands back the dialog's promise, so the picker can put
    // the cursor back when it closes. Held open here until a test resolves it.
    return new Promise<void>(resolve => { closeWorkflowDialog = () => resolve(); });
  });

  return {
    fleet,
    ui,
    manager,
    setWorkflows: (list: FleetWorkflow[]) => { workflows = list; },
    openedWorkflows: () => openedWorkflows,
    closeWorkflowDialog: async () => { closeWorkflowDialog?.(); await Promise.resolve(); },
    press: (data) => inputHandler?.(data),
    setEditorText: (t) => { editorText = t; },
    overlay: () => overlays[overlays.length - 1],
    overlayCount: () => overlays.length,
    render: (width = 120) => overlays.length ? overlays[overlays.length - 1].component.render(width) : [],
    overlayKey: (data) => overlays[overlays.length - 1]?.component.handleInput(data),
    tui: fakeTui,
  };
}

/** ← at the empty prompt — the only way the picker opens. */
function openPicker(h: Harness): void {
  expect(h.press(LEFT)).toEqual({ consume: true });
  expect(h.overlayCount()).toBe(1);
}

describe("formatFleetElapsed", () => {
  it("renders integer seconds (no decimal, no suffix)", () => {
    expect(formatFleetElapsed(0)).toBe("0s");
    expect(formatFleetElapsed(11_000)).toBe("11s");
    expect(formatFleetElapsed(11_400)).toBe("11s");
    expect(formatFleetElapsed(11_600)).toBe("12s");
  });
  it("floors negatives to 0s", () => {
    expect(formatFleetElapsed(-500)).toBe("0s");
  });
});

describe("formatFleetTokens", () => {
  it("prefixes a down-arrow and uses plural 'tokens'", () => {
    expect(formatFleetTokens(13_100)).toBe("↓ 13.1k tokens");
    expect(formatFleetTokens(950)).toBe("↓ 950 tokens");
    expect(formatFleetTokens(1_200_000)).toBe("↓ 1.2M tokens");
  });
});

describe("FleetList activation", () => {
  it("opens the picker on ← at an empty prompt, consuming the key", () => {
    const h = harness([makeRecord()]);
    const res = h.press(LEFT);
    expect(res).toEqual({ consume: true });
    expect(h.overlay()).toBeDefined();
  });

  it("opens the picker even when no agents exist (just 'main')", () => {
    const h = harness([]);
    openPicker(h);
    expect(h.render().some(l => l.includes("main"))).toBe(true);
  });

  it("does NOT open on ↓", () => {
    const h = harness([makeRecord()]);
    expect(h.press(DOWN)).toBeUndefined();
    expect(h.overlayCount()).toBe(0);
  });

  it("does NOT open when the prompt is non-empty (typing is preserved)", () => {
    const h = harness([makeRecord()]);
    h.setEditorText("hello");
    expect(h.press(LEFT)).toBeUndefined();
    expect(h.overlayCount()).toBe(0);
  });

  it("ignores key-release events so one tap opens exactly once", () => {
    const h = harness([makeRecord()]);
    expect(h.press(LEFT_RELEASE)).toBeUndefined(); // the release half of a tap
    expect(h.overlayCount()).toBe(0);
    expect(h.press(LEFT)).toEqual({ consume: true }); // the real press half
  });

  it("ignores all input while disabled", () => {
    const h = harness([makeRecord()]);
    h.fleet.setEnabled(false);
    expect(h.press(LEFT)).toBeUndefined();
    expect(h.overlayCount()).toBe(0);
  });
});

describe("FleetList vs other focused components (#123)", () => {
  // pi dispatches terminal input to extension listeners BEFORE the focused
  // component (pi-tui TUI.handleInput), and ctx.ui.select/confirm/input swap
  // the prompt editor out of the editor container while getEditorText() still
  // reads the detached (empty) editor. So while another component owns the
  // keyboard — another extension's selector (rpiv-ask-user-question), pi's own
  // menus, our /agents settings — the list must not consume its keys.

  /** A minimal real Editor — what pi focuses at the prompt (CustomEditor extends it). */
  function realEditor(): Editor {
    const fakeTui = { requestRender: () => {} };
    const theme = { borderColor: (s: string) => s, selectList: {} };
    return new Editor(fakeTui as any, theme as any);
  }

  /** Hand the fleet list its `tui` (captured from the first overlay) with the given focus. */
  function focusInHarness(h: Harness, focused: unknown): void {
    h.tui.focusedComponent = focused;
    h.render();
  }

  it("does not steal ← from a focused selector", async () => {
    const h = harness([makeRecord()]);
    openPicker(h); // captures the TUI instance
    h.overlayKey(ESC);
    await flush();
    focusInHarness(h, { kind: "selector" }); // e.g. ExtensionSelectorComponent
    expect(h.press(LEFT)).toBeUndefined(); // must flow through to the selector
  });

  it("still opens when the prompt editor has focus", () => {
    const h = harness([makeRecord()]);
    focusInHarness(h, realEditor());
    expect(h.press(LEFT)).toEqual({ consume: true });
  });

  it("assumes the editor when focus is unknowable (no tui seen yet / nothing focused)", () => {
    const h = harness([makeRecord()]);
    // No overlay has been opened yet → the list has never seen a tui: activation must still work.
    expect(h.press(LEFT)).toEqual({ consume: true });
  });

  it("lets every key flow to the open overlay (the listener stands aside)", () => {
    const h = harness([makeRecord()]);
    openPicker(h);
    expect(h.press(DOWN)).toBeUndefined();
    expect(h.press(ENTER)).toBeUndefined();
    expect(h.press(ESC)).toBeUndefined();
    // ...and the overlay itself still navigated.
    h.overlayKey(DOWN);
    expect(h.render().find(l => l.includes("Sleep then report 1"))).toContain("●");
  });
});

describe("FleetList picker roster", () => {
  it("offers main plus retained top-level agents with sessions, in manager order (newest first)", () => {
    const h = harness([
      makeRecord({ id: "live", description: "running one", startedAt: 2000 }),
      makeRecord({ id: "done", description: "finished one", status: "completed", completedAt: Date.now() - 500, startedAt: 1000 }),
      makeRecord({ id: "stopped", description: "stopped one", status: "stopped", completedAt: Date.now() - 500, startedAt: 500 }),
      makeRecord({ id: "nested", description: "nested-child", parentAgentId: "live" }),
      makeRecord({ id: "pending", description: "queued one", status: "queued", session: undefined }),
    ]);
    openPicker(h);
    const lines = h.render().join("\n");
    expect(lines).toContain("main");
    expect(lines).toContain("running one");
    expect(lines).toContain("finished one"); // retained, not just running/recent
    expect(lines).toContain("stopped one");
    expect(lines).not.toContain("nested-child");
    expect(lines).toContain("queued one"); // visible before its session starts
    // Lifecycle groups override manager order; order within each group stays stable.
    expect(lines.indexOf("queued one")).toBeLessThan(lines.indexOf("running one"));
    expect(lines.indexOf("running one")).toBeLessThan(lines.indexOf("finished one"));
    expect(lines.indexOf("finished one")).toBeLessThan(lines.indexOf("stopped one"));
  });

  it("groups every lifecycle status under a counted heading", () => {
    const h = harness([
      makeRecord({ id: "queued", description: "queued agent", status: "queued", session: undefined }),
      makeRecord({ id: "running", description: "running agent", status: "running" }),
      makeRecord({ id: "completed", description: "completed agent", status: "completed" }),
      makeRecord({ id: "steered", description: "steered agent", status: "steered" }),
      makeRecord({ id: "aborted", description: "aborted agent", status: "aborted" }),
      makeRecord({ id: "stopped", description: "stopped agent", status: "stopped" }),
      makeRecord({ id: "error", description: "error agent", status: "error" }),
    ]);
    h.tui.terminal.rows = 20;
    openPicker(h);
    const lines = h.render().join("\n");
    expect(lines).toContain("Queued (1)");
    expect(lines).toContain("Running (1)");
    expect(lines).toContain("Finished (2)");
    expect(lines).toContain("Failed (3)");
    expect(lines.indexOf("Queued (1)")).toBeLessThan(lines.indexOf("queued agent"));
    expect(lines.indexOf("Running (1)")).toBeLessThan(lines.indexOf("running agent"));
    expect(lines.indexOf("Finished (2)")).toBeLessThan(lines.indexOf("completed agent"));
    expect(lines.indexOf("Failed (3)")).toBeLessThan(lines.indexOf("aborted agent"));
  });

  it("keeps the selected agent when its status moves it to another group", () => {
    const agents = [
      makeRecord({ id: "moving", description: "moving agent", status: "running" }),
      makeRecord({ id: "other", description: "other agent", status: "running" }),
    ];
    const h = harness(agents);
    openPicker(h);
    h.overlayKey(DOWN);
    expect(h.render().find(line => line.includes("moving agent"))).toContain("●");
    agents[0] = makeRecord({ id: "moving", description: "moving agent", status: "completed" });
    expect(h.render().find(line => line.includes("moving agent"))).toContain("●");
    expect(h.render().find(line => line.includes("other agent"))).toContain("○");
  });

  it("caps the roster at 30 agents", () => {
    const agents = Array.from({ length: 35 }, (_, i) =>
      makeRecord({ id: `a${i}`, description: `report ${i}` }));
    const h = harness(agents);
    h.tui.terminal.rows = 100; // tall enough that the cap, not the viewport, is the limit
    openPicker(h);
    const lines = h.render().join("\n");
    expect(lines).toContain("report 29");  // 30th agent (newest first) still listed
    expect(lines).not.toContain("report 30"); // the rest are dropped
  });

  it("windows the roster to the terminal height with 'more' indicators", () => {
    const agents = Array.from({ length: 8 }, (_, i) =>
      makeRecord({ id: `a${i}`, description: `report ${i}` }));
    const h = harness(agents);
    h.tui.terminal.rows = 10; // hint + blank + 7 display lines + overflow = 10 lines
    openPicker(h);
    expect(h.render(120).some(l => l.includes("↓ 6 more"))).toBe(true);
    expect(h.render(120)).toHaveLength(10); // every line fits the terminal
  });

  it("windows so the selection stays visible when scrolled to the bottom", () => {
    const agents = Array.from({ length: 8 }, (_, i) =>
      makeRecord({ id: `a${i}`, description: `report ${i}` }));
    const h = harness(agents);
    h.tui.terminal.rows = 10;
    openPicker(h);
    for (let i = 0; i < 9; i++) h.overlayKey(DOWN); // → last agent (roster index 8)
    const lines = h.render(120);
    expect(lines.find(l => l.includes("report 7"))).toContain("●");
    expect(lines.some(l => l.includes("↑"))).toBe(true); // hidden-above indicator
    expect(lines).toHaveLength(10);
  });

  it("never emits a line wider than the terminal (guards wrap-induced flicker)", () => {
    const agents = Array.from({ length: 8 }, (_, i) =>
      makeRecord({ id: `a${i}`, description: `a very long agent description number ${i} that keeps going` }));
    const h = harness(agents);
    openPicker(h);
    for (const w of [4, 8, 12, 20, 40, 80, 200]) {
      for (const line of h.render(w)) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(w);
      }
    }
  });
});

describe("FleetList picker navigation", () => {
  it("moves selection down/up and clamps at the ends", () => {
    const h = harness([
      makeRecord({ id: "a1", description: "one" }),
      makeRecord({ id: "a2", description: "two" }),
    ]);
    openPicker(h);
    expect(h.render().find(l => l.includes("main"))).toContain("●");
    h.overlayKey(DOWN); // → a1
    expect(h.render().find(l => l.includes("one"))).toContain("●");
    h.overlayKey(DOWN); // → a2
    h.overlayKey(DOWN); // clamp at a2
    expect(h.render().find(l => l.includes("two"))).toContain("●");
    h.overlayKey(UP);  // → a1
    h.overlayKey(UP);  // → main
    h.overlayKey(UP);  // clamp at main
    expect(h.render().find(l => l.includes("main"))).toContain("●");
  });

  it("Esc closes the picker to main (no viewer)", async () => {
    const h = harness([makeRecord()]);
    openPicker(h);
    h.overlayKey(ESC);
    await flush();
    expect(h.overlay()!.closed).toBe(true);
    expect(h.overlayCount()).toBe(1); // nothing reopened
  });

  it("Enter on 'main' closes to main (no viewer)", async () => {
    const h = harness([makeRecord()]);
    openPicker(h);
    h.overlayKey(ENTER); // main is the default selection
    await flush();
    expect(h.overlay()!.closed).toBe(true);
    expect(h.overlayCount()).toBe(1);
  });

  it("passes non-nav keys through untouched", () => {
    const h = harness([makeRecord()]);
    openPicker(h);
    h.overlayKey(RIGHT);
    expect(h.render().find(l => l.includes("main"))).toContain("●"); // still on main
  });

  it("ignores key-release events so one tap moves exactly one row", () => {
    const h = harness([
      makeRecord({ id: "a1", description: "one" }),
      makeRecord({ id: "a2", description: "two" }),
    ]);
    openPicker(h);
    h.overlayKey(DOWN_RELEASE); // the release half of a tap — must be a no-op
    expect(h.render().find(l => l.includes("main"))).toContain("●");
    h.overlayKey(DOWN);         // the real press → first agent
    h.overlayKey(DOWN_RELEASE);
    expect(h.render().find(l => l.includes("one"))).toContain("●");
    expect(h.render().find(l => l.includes("two"))).toContain("○");
  });
});

describe("FleetList picker rendering", () => {
  it("renders main + agent rows with markers, type, description and right-aligned stats", () => {
    const h = harness([makeRecord({ description: "Sleep then report 1" })]);
    openPicker(h);
    const lines = h.render(120);
    expect(lines[0]).toContain("↑↓ select · enter view · esc close");
    expect(lines.find(l => l.includes("main"))).toContain("●"); // main selected by default
    const agentLine = lines.find(l => l.includes("Sleep then report 1"))!;
    expect(agentLine).toContain("○");
    expect(agentLine).toContain(getDisplayName("general-purpose"));
    expect(agentLine).toContain("↓ 13.1k tokens");
    expect(agentLine).toMatch(/\d+s · ↓/); // "<seconds>s · ↓ ..." (timing-agnostic)
  });

  it("renders the whole selected row in the theme's primary text color (#230)", () => {
    const h = harness([
      makeRecord({ id: "a1", description: "one" }),
      makeRecord({ id: "a2", description: "two" }),
    ]);
    openPicker(h);
    h.overlayKey(DOWN); // → a1
    const selected = h.render().find(l => l.includes("one"))!;
    // Selection marker keeps accent color; row content uses primary text color.
    expect(selected).toContain("<accent>●</accent>");
    expect(selected).toContain("<text>one</text>");
    expect(selected).toMatch(/<text>\d+s · ↓ [\d.]+k? tokens<\/text>/);
    // Agent display name rendered with the text token too (this type has no badge).
    expect(selected).toContain(`<text>${getDisplayName("general-purpose")}</text>`);
    // Inactive rows keep the muted/dim treatment.
    const unselected = h.render().find(l => l.includes("two"))!;
    expect(unselected).toContain("<dim>○</dim>");
    expect(unselected).toMatch(/<dim>\d+s · ↓ [\d.]+k? tokens<\/dim>/);
    expect(unselected).not.toContain("<text>");
  });

  it("keeps a color badge on the selected row, bolded, without shifting it (#230)", () => {
    registerAgents(new Map([[BADGED_TYPE, BADGED_CONFIG]]));
    try {
      const h = harness([
        makeRecord({ id: "a1", type: BADGED_TYPE, description: "one" }),
        makeRecord({ id: "a2", type: BADGED_TYPE, description: "two" }),
      ]);
      openPicker(h);
      const before = h.render().find(l => l.includes("one"))!;
      expect(before).toContain(`${PURPLE_BACKGROUND}`);
      expect(before).toContain(` ${BADGED_CONFIG.displayName} `);

      h.overlayKey(DOWN); // → a1
      const selected = h.render().find(l => l.includes("one"))!;
      // Selection bolds the badge rather than repainting it (Claude Code's FleetView) …
      expect(selected).toContain(PURPLE_BACKGROUND);
      expect(selected).toContain(`* ${BADGED_CONFIG.displayName} *`);
      expect(selected).not.toContain(`<text>${BADGED_CONFIG.displayName}`);
      // … so the description stays in the same column as when unselected.
      expect(plain(selected).indexOf("one")).toBe(plain(before).indexOf("one"));
    } finally {
      registerAgents(new Map());
    }
  });
});

describe("FleetList picker ↔ viewer flow", () => {
  it("Enter on an agent opens the conversation viewer after the picker closed", async () => {
    const agents = [
      makeRecord({ id: "a1", description: "one" }),
      makeRecord({ id: "a2", description: "two" }),
    ];
    const h = harness(agents);
    openPicker(h);
    const picker = h.overlay();
    h.overlayKey(DOWN);         // → a1
    h.overlayKey(DOWN);         // → a2
    h.overlayKey(ENTER);        // open a2
    expect(picker!.closed).toBe(true); // picker fully closed first — overlays never stack
    await flush();
    expect(h.overlayCount()).toBe(2);
    expect(h.overlay()!.component).not.toBe(picker!.component); // now the viewer
  });

  it("Esc from the viewer returns to the picker with the selection preserved", async () => {
    const agents = [
      makeRecord({ id: "a1", description: "one" }),
      makeRecord({ id: "a2", description: "two" }),
      makeRecord({ id: "a3", description: "three" }),
    ];
    const h = harness(agents);
    openPicker(h);
    h.overlayKey(DOWN);  // → a1
    h.overlayKey(DOWN);  // → a2
    h.overlayKey(DOWN);  // → a3
    h.overlayKey(ENTER); // open a3
    await flush();
    h.overlayKey(ESC);   // Esc from the viewer…
    await flush();
    expect(h.overlayCount()).toBe(3); // …reopens the picker
    expect(h.render().find(l => l.includes("three"))).toContain("●");
  });

  it("keeps the selection on the viewed agent after closing, even if the roster reordered", async () => {
    const agents = [
      makeRecord({ id: "a1", description: "one" }),
      makeRecord({ id: "a2", description: "two" }),
      makeRecord({ id: "a3", description: "three" }),
    ];
    const h = harness(agents);
    openPicker(h);
    h.overlayKey(DOWN);  // → a1
    h.overlayKey(DOWN);  // → a2
    h.overlayKey(DOWN);  // → a3
    h.overlayKey(ENTER); // open a3
    await flush();
    // a1 finishes and drops out of the roster while viewing → a3 shifts up.
    agents.splice(0, 1);
    h.overlayKey(ESC); // close the viewer
    await flush();
    expect(h.render().find(l => l.includes("three"))).toContain("●");
    expect(h.render().find(l => l.includes("two"))).toContain("○");
  });

  it("wires the viewer's steer composer to manager.steer with the agent id", async () => {
    const agents = [makeRecord({ id: "live", description: "the one" })];
    const h = harness(agents);
    openPicker(h);
    h.overlayKey(DOWN);  // → the agent
    h.overlayKey(ENTER); // open the conversation viewer
    await flush();

    h.overlayKey("\r");                        // Enter → open composer
    for (const ch of "go left") h.overlayKey(ch);
    h.overlayKey("\r");                        // Enter → send

    expect(h.manager.steer).toHaveBeenCalledWith("live", "go left");
  });

  it("wires the viewer's stop (x twice) to manager.abort", async () => {
    const agents = [makeRecord({ id: "live", description: "the one" })];
    const h = harness(agents);
    openPicker(h);
    h.overlayKey(DOWN);  // → the agent
    h.overlayKey(ENTER); // open the conversation viewer
    await flush();
    h.overlayKey("x");   // arm
    h.overlayKey("x");   // confirm
    expect(h.manager.abort).toHaveBeenCalledWith("live");
  });

  it("hands the viewer the user's markdown setting, and persists a mode chosen with m", async () => {
    const persisted: ViewerMarkdownMode[] = [];
    const h = harness([makeRecord({ id: "live", description: "the one" })], {
      viewerMarkdown: () => "all",
      onViewerMarkdown: (mode) => persisted.push(mode),
    });
    openPicker(h);
    h.overlayKey(DOWN);  // → the agent
    h.overlayKey(ENTER); // open the conversation viewer
    await flush();

    h.overlayKey("m");

    // "all" → "off" proves the cycle started from the *setting*; the viewer's own
    // fallback would have started at "assistant" and landed on "all". A recorded
    // value at all proves the persist hook is wired, as it is from /agents.
    expect(persisted).toEqual(["off"]);
  });

  it("does NOT auto-close when the viewed agent finishes (final output stays readable)", async () => {
    const agents = [makeRecord({ id: "live", description: "the one" })];
    const h = harness(agents);
    openPicker(h);
    h.overlayKey(DOWN);  // → the agent
    h.overlayKey(ENTER); // opens the viewer
    await flush();
    expect(h.overlayCount()).toBe(2);
    // The agent finishes, well past any cleanup window...
    agents[0] = makeRecord({ id: "live", description: "the one", status: "completed", completedAt: Date.now() - 60_000 });
    h.fleet.onAgentFinished("live");
    expect(h.overlay()!.closed).toBe(false); // viewer stays open
    // Esc from the viewer returns to the picker, and the finished agent is
    // still retained there (only tombstones drop out).
    h.overlayKey(ESC);
    await flush();
    expect(h.overlayCount()).toBe(3);
    expect(h.render().some(l => l.includes("the one"))).toBe(true);
  });
});

describe("FleetList lifecycle teardown", () => {
  it("does not suppress the first agent selection after disabling with no overlay open", async () => {
    const h = harness([makeRecord()]);
    h.fleet.setEnabled(false);
    h.fleet.setEnabled(true);
    openPicker(h);
    h.overlayKey(DOWN);
    h.overlayKey(ENTER);
    await flush();
    expect(h.overlayCount()).toBe(2);
  });

  it("dispose while the picker is open closes it without reopening", async () => {
    const h = harness([makeRecord()]);
    openPicker(h);
    h.fleet.dispose();
    await flush(); // the closed picker's promise resolves — must not reopen
    expect(h.overlay()!.closed).toBe(true);
    expect(h.overlayCount()).toBe(1);
    expect(h.press(LEFT)).toBeUndefined(); // input handler unsubscribed
  });

  it("dispose while the viewer is open closes it without reopening the picker", async () => {
    const h = harness([makeRecord()]);
    openPicker(h);
    h.overlayKey(DOWN);  // → the agent
    h.overlayKey(ENTER); // open the viewer
    await flush();
    expect(h.overlayCount()).toBe(2);
    h.fleet.dispose();
    await flush();
    expect(h.overlayCount()).toBe(2); // no picker reopened on top
  });

  it("disabling closes an open picker without reopening; re-enabling works again", async () => {
    const h = harness([makeRecord()]);
    openPicker(h);
    h.fleet.setEnabled(false);
    await flush();
    expect(h.overlay()!.closed).toBe(true);
    expect(h.overlayCount()).toBe(1);
    h.fleet.setEnabled(true);
    expect(h.press(LEFT)).toEqual({ consume: true });
    expect(h.overlayCount()).toBe(2);
  });
});

describe("FleetList cost display", () => {
  const theme = { fg: (_c: string, s: string) => s, bold: (s: string) => s };

  function row(showCost: boolean, cost: number, activity?: Map<string, AgentActivity>): string {
    const record = makeRecord({ lifetimeUsage: { input: 13100, output: 0, cacheWrite: 0, cost } });
    const fleet = new FleetList(fakeManager([record]), activity ?? new Map(), () => showCost);
    let inputHandler: ((data: string) => any) | undefined;
    let component: any;
    fleet.setUICtx({
      onTerminalInput: (h) => { inputHandler = h; return () => {}; },
      getEditorText: () => "",
      notify: () => {},
      custom: ((factory: any) => new Promise(() => {
        component = factory({ requestRender: () => {}, terminal: { columns: 120, rows: 40 } }, theme, undefined, () => {});
      })) as any,
    } as any);
    inputHandler?.(LEFT);
    return component.render(120).join("\n");
  }

  it("appends the cost after the token count when enabled", () => {
    const out = row(true, 0.0042);
    expect(out).toContain("13.1k tokens");
    expect(out).toContain("~$0.0042");
  });

  it("shows no cost when disabled, and none for an unpriced model", () => {
    expect(row(false, 0.0042)).not.toContain("$");
    expect(row(true, 0)).not.toContain("$");
  });

  it("reads the record, so the figures do not change when the agent finishes", () => {
    // Spend used to come from the live activity tracker while an agent ran and
    // from its record once the tracker was deleted. The two disagree: only the
    // record carries a nested child's spend (nested-tools folds it into every
    // ancestor), so the number jumped upward at completion.
    // The stale shape on purpose: an activity entry carrying figures of its own
    // is what the old fallback preferred, so a row that still renders the
    // record's numbers proves the tracker is no longer consulted for spend.
    const tracked = new Map<string, AgentActivity>([["a1", {
      activeTools: new Map(), toolUses: 0, responseText: "", turnCount: 1,
      lifetimeUsage: { input: 1, output: 1, cacheWrite: 0, cost: 0.9 },
    } as unknown as AgentActivity]]);

    expect(row(true, 0.0042, tracked)).toBe(row(true, 0.0042));
  });
});

/* ------------------------------------------------------------------------- *
 * Workflow runs
 * ------------------------------------------------------------------------- */

describe("FleetList workflow rows", () => {
  it("renders identically with no workflow source and an empty one", () => {
    // The contract: a session without workflows behaves exactly as it did
    // before they existed. Asserted as an equality rather than an absence, so
    // a future change to the roster cannot quietly alter the agents-only path.
    const withNone = harness([makeRecord({ id: "a1", description: "one" })]);
    openPicker(withNone);
    const before = withNone.render().join("\n");
    expect(before).not.toContain("workflow");

    const withEmpty = harness([makeRecord({ id: "a1", description: "one" })]);
    withEmpty.setWorkflows([]);
    openPicker(withEmpty);
    expect(withEmpty.render().join("\n")).toBe(before);
  });

  it("navigates agents exactly as before when no run is present", async () => {
    const h = harness([
      makeRecord({ id: "a1", description: "one" }),
      makeRecord({ id: "a2", description: "two" }),
    ]);
    h.setWorkflows([]);

    openPicker(h);
    h.overlayKey(DOWN); // → a1
    h.overlayKey(DOWN); // → a2
    h.overlayKey(ENTER);
    await flush();

    // The second agent, not a run and not `main`.
    expect(h.openedWorkflows()).toEqual([]);
    expect(h.overlayCount()).toBe(2); // the conversation viewer, not an inspector
  });

  it("lists a run above the agent groups, with its counts and stats", () => {
    const h = harness([makeRecord({ id: "a1", description: "one" })]);
    h.setWorkflows([makeWorkflow()]);
    openPicker(h);

    const rows = h.render().map(plain).filter(row => row.trim() !== "");
    const run = rows.find(row => row.includes("audit-src"))!;
    const agent = rows.findIndex(row => row.includes("one"));
    expect(run).toContain("workflow");
    expect(run).toContain("1/3 agents");
    expect(run).toContain("26.4k tokens");
    // Runs sit in their own section above the agent groups: the container comes first.
    expect(rows.findIndex(row => row.includes("Workflows (1)"))).toBeLessThan(agent);
    expect(rows.findIndex(row => row.includes("audit-src"))).toBeLessThan(agent);
  });

  it("agrees with itself about a single-agent run", () => {
    const h = harness([]);
    h.setWorkflows([makeWorkflow({ doneCount: 1, totalCount: 1 })]);
    openPicker(h);
    expect(h.render().map(plain).join("\n")).toContain("1/1 agent ");
  });

  it("hides the run's own agents — the run is the row that represents them", () => {
    // A 40-agent fan-out would otherwise push every other agent off the picker,
    // and each child is already reachable inside the workflow dialog.
    const h = harness([
      makeRecord({ id: "a1", description: "mine" }),
      makeRecord({ id: "w1", description: "the workflow's", workflowId: "wf_abc123" }),
    ]);
    h.setWorkflows([makeWorkflow()]);

    openPicker(h);
    const rendered = h.render().map(plain).join("\n");
    expect(rendered).toContain("mine");
    expect(rendered).toContain("audit-src");
    expect(rendered).not.toContain("the workflow's");
  });

  it("opens a run from the picker even when it is the only row besides 'main'", async () => {
    // The run is the row the user opens to see what its children did — a picker
    // with nothing but the run still has somewhere to go.
    const h = harness([]);
    h.setWorkflows([makeWorkflow({ id: "wf_only" })]);

    openPicker(h);
    h.overlayKey(DOWN); // → the run
    h.overlayKey(ENTER);
    await flush(); // the picker's close handoff to the inspector

    expect(h.openedWorkflows()).toEqual(["wf_only"]);
  });

  it("still does nothing at an empty prompt with no rows at all", () => {
    const h = harness([]);
    expect(h.press(LEFT)?.consume).toBe(true); // main alone is still a row
  });

  it("opens the selected run rather than a conversation viewer", async () => {
    const h = harness([makeRecord({ id: "a1", description: "one" })]);
    h.setWorkflows([makeWorkflow({ id: "wf_pick" })]);

    openPicker(h);
    h.overlayKey(DOWN); // → the run
    h.overlayKey(ENTER);
    await flush();

    expect(h.openedWorkflows()).toEqual(["wf_pick"]);
    // The workflow dialog owns its own overlay; the picker must not open one.
    expect(h.overlayCount()).toBe(1); // picker closed, no viewer on top
    expect(h.overlay()!.closed).toBe(true);
  });

  const NOW = Date.now();

  /** Open the second of two runs, leaving the inspector up. */
  async function openSecondRun() {
    const h = harness([makeRecord({ id: "a1", description: "one" })]);
    h.setWorkflows([
      makeWorkflow({ id: "wf_a", name: "audit-src", startedAt: NOW - 30_000 }),
      makeWorkflow({ id: "wf_b", name: "review-changes", startedAt: NOW - 20_000 }),
    ]);
    openPicker(h);
    h.overlayKey(DOWN);
    h.overlayKey(DOWN);
    expect(h.openedWorkflows()).toEqual([]);
    h.overlayKey(ENTER);
    await flush(); // the picker's close handoff to the inspector
    expect(h.openedWorkflows()).toEqual(["wf_b"]);
    return h;
  }

  it("keeps its hands off the keyboard while the inspector is up", async () => {
    // The picker only stays out of the inspector's keys when it knows one is
    // open. Focus alone is not enough: `editorHasFocus` reads unknowable focus
    // as the editor's, which is exactly the state a fresh overlay leaves
    // behind, and the picker would then eat the keys the dialog is waiting for.
    const h = await openSecondRun();

    expect(h.press(DOWN)?.consume, "the dialog's keys are not the picker's").toBeFalsy();
    expect(h.press(ENTER)?.consume).toBeFalsy();
    // And nothing moved behind it — one ENTER opened one run.
    expect(h.openedWorkflows()).toEqual(["wf_b"]);
  });

  it("comes back to the same run when the inspector closes", async () => {
    // Runs settle and start while the dialog is open, so the row the reader
    // came from is not reliably where it was. The agent path re-finds its row
    // by id for the same reason; a run has to be findable the same way.
    const h = await openSecondRun();

    h.setWorkflows([
      makeWorkflow({ id: "wf_a", name: "audit-src", startedAt: NOW - 30_000 }),
      makeWorkflow({ id: "wf_new", name: "started-meanwhile", startedAt: NOW - 25_000 }),
      makeWorkflow({ id: "wf_b", name: "review-changes", startedAt: NOW - 20_000 }),
    ]);
    await h.closeWorkflowDialog();

    expect(h.render().find(l => l.includes("review-changes"))).toContain("●");
    expect(h.render().find(l => l.includes("started-meanwhile"))).not.toContain("●");
  });

  it("drops the native child transcript before opening a workflow inspector, then reselects the run", async () => {
    // View an agent through the native transcript (no overlay), switch to the
    // picker, and open a run from it: the child's transcript must be dropped
    // before the inspector opens, and its id must not survive the trip.
    const clear = vi.spyOn(transcriptOverride, "clear");
    vi.spyOn(transcriptOverride, "show").mockReturnValue(true);
    try {
      const h = harness([makeRecord({ id: "a1", description: "one" })]);
      h.setWorkflows([makeWorkflow({ id: "wf_x", name: "audit-src" })]);
      openPicker(h);
      h.overlayKey(DOWN);  // → the run
      h.overlayKey(DOWN);  // → the agent
      h.overlayKey(ENTER); // native transcript: show() succeeded, no overlay
      await flush();
      expect(h.overlayCount()).toBe(1); // the picker only — no viewer overlay
      expect(h.press(ENTER)).toEqual({ consume: true }); // still viewing the agent

      // ← from the native transcript reopens the picker…
      expect(h.press(LEFT)).toEqual({ consume: true });
      expect(h.overlayCount()).toBe(2);
      h.overlayKey(UP);    // …back up to the run…
      h.overlayKey(ENTER); // …and into its inspector.
      await flush();
      expect(h.openedWorkflows()).toEqual(["wf_x"]);
      // The child's native transcript was dropped the moment the inspector opened.
      expect(clear).toHaveBeenCalled();
      // Input belongs to the inspector now — none of it reaches the prompt.
      expect(h.press(ENTER)).toBeUndefined();
      expect(h.press(DOWN)).toBeUndefined();

      // The roster reorders while the inspector is up; closing still lands on
      // the run we came from, found by id.
      h.setWorkflows([
        makeWorkflow({ id: "wf_x", name: "audit-src", startedAt: Date.now() - 32_000 }),
        makeWorkflow({ id: "wf_new", name: "started-meanwhile", startedAt: Date.now() - 25_000 }),
      ]);
      await h.closeWorkflowDialog();
      expect(h.render().find(l => l.includes("audit-src"))).toContain("●");
      expect(h.render().find(l => l.includes("started-meanwhile"))).not.toContain("●");
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("does not reopen the picker when the inspector settles after disable", async () => {
    const h = harness([makeRecord()]);
    h.setWorkflows([makeWorkflow({ id: "wf_x" })]);
    openPicker(h);
    h.overlayKey(DOWN);  // → the run
    h.overlayKey(ENTER); // open the inspector
    await flush();
    expect(h.openedWorkflows()).toEqual(["wf_x"]);

    h.fleet.setEnabled(false);
    await h.closeWorkflowDialog(); // the inspector settles while disabled
    expect(h.overlayCount()).toBe(1); // nothing reopened

    h.fleet.setEnabled(true);
    expect(h.press(LEFT)).toEqual({ consume: true }); // the picker works again
    expect(h.overlayCount()).toBe(2);
  });

  it("does not reopen the picker when the inspector settles after dispose", async () => {
    const h = harness([makeRecord()]);
    h.setWorkflows([makeWorkflow({ id: "wf_x" })]);
    openPicker(h);
    h.overlayKey(DOWN);  // → the run
    h.overlayKey(ENTER); // open the inspector
    await flush();

    h.fleet.dispose();
    await h.closeWorkflowDialog(); // the inspector settles after the list is gone
    expect(h.overlayCount()).toBe(1); // nothing reopened on top
    expect(h.press(LEFT)).toBeUndefined(); // input handler unsubscribed
  });

  it("still opens an agent's viewer when the selection is past the runs", async () => {
    const h = harness([makeRecord({ id: "a1", description: "one" })]);
    h.setWorkflows([makeWorkflow()]);

    openPicker(h);
    h.overlayKey(DOWN); // → the run
    h.overlayKey(DOWN); // → the agent
    h.overlayKey(ENTER);
    await flush();

    expect(h.openedWorkflows()).toEqual([]);
    expect(h.overlayCount()).toBe(2); // the conversation viewer
  });

  it("drops a settled run once it stops lingering, and keeps a live one", () => {
    const h = harness([]);
    h.setWorkflows([
      makeWorkflow({ id: "wf_old", name: "old", status: "completed", completedAt: Date.now() - 60 * 60_000 }),
      makeWorkflow({ id: "wf_now", name: "now" }),
    ]);

    openPicker(h);
    const rendered = h.render().map(plain).join("\n");
    expect(rendered).toContain("now");
    expect(rendered).not.toContain("old");
  });

  it("freezes a finished run's clock the way an agent's is frozen", () => {
    const h = harness([]);
    // Inside FINISHED_LINGER_MS, or the row would be gone before it could be read.
    const completedAt = Date.now() - 1_000;
    h.setWorkflows([makeWorkflow({ status: "completed", startedAt: completedAt - 12_000, completedAt })]);

    openPicker(h);
    expect(h.render().map(plain).join("\n")).toContain("12s");
  });
});