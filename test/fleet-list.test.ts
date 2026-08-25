import { Editor, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import type { AgentManager } from "../src/agent-manager.js";
import { registerAgents } from "../src/agent-types.js";
import type { AgentConfig, AgentRecord } from "../src/types.js";
import { type AgentActivity, getDisplayName } from "../src/ui/agent-widget.js";
import { FleetList, type FleetUICtx, formatFleetElapsed, formatFleetTokens } from "../src/ui/fleet-list.js";

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

function harness(agents: AgentRecord[]): Harness {
  let inputHandler: ((data: string) => { consume?: boolean } | undefined) | undefined;
  let editorText = "";
  const overlays: Overlay[] = [];
  const fakeTui = { requestRender: () => {}, terminal: { columns: 120, rows: 40 } };

  const ui: FleetUICtx = {
    onTerminalInput: (h) => { inputHandler = h; return () => { inputHandler = undefined; }; },
    getEditorText: () => editorText,
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
  const fleet = new FleetList(manager, new Map());
  fleet.setUICtx(ui);

  return {
    fleet,
    ui,
    manager,
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