/**
 * widget.bench.ts — the always-on surface, `AgentWidget`.
 *
 * It caches nothing about the agent list: it scans it twice per cycle — once in
 * `update()`, once again in `renderWidget()` — and each scan is a `listAgents()`
 * copy-and-sort. It renders on every TUI frame, not just on its own timer,
 * because it sits beside the editor: a keystroke in the main session redraws it.
 *
 * `render` and `update` are measured apart because they run at different rates
 * (per frame vs. an 80 ms timer plus ~10 call sites in index.ts) and a
 * regression in one says nothing about the other.
 *
 * Cleanup is in `afterAll`, NOT in tinybench's per-task `teardown`: that hook
 * fires between the warmup and sampling phases, and `dispose()` unregisters the
 * widget by calling `setWidget(key, undefined)`. The first version of this file
 * disposed in `teardown` and reported 33 million renders per second — it was
 * measuring an unregistered widget returning an empty array.
 */
import { afterAll, bench, describe } from "vitest";
import { AgentWidget } from "../../src/ui/agent-widget.js";
import { makeFleet, mountWidget } from "../helpers/perf-fixtures.js";

/** Fleet sizes: one agent, a normal fan-out, and a pathological one. */
const SIZES = [1, 10, 100];

/** Everything mounted here, torn down once at the end (the widget holds a timer). */
const mounted: { dispose: () => void }[] = [];
function track<T extends { dispose: () => void }>(m: T): T {
  mounted.push(m);
  return m;
}
afterAll(() => {
  for (const m of mounted) m.dispose();
});

describe("AgentWidget.render (per TUI frame)", () => {
  for (const n of SIZES) {
    const w = track(mountWidget(AgentWidget, makeFleet({ running: n })));
    bench(`${n} agents`, () => {
      w.render();
    });
  }
});

describe("AgentWidget.update (80ms timer + ~10 call sites)", () => {
  for (const n of SIZES) {
    const w = track(mountWidget(AgentWidget, makeFleet({ running: n })));
    bench(`${n} agents`, () => {
      w.update();
    });
  }
});

describe("AgentWidget.render — the widget's real mix", () => {
  // What a fan-out actually looks like on screen: a few running, a queue behind
  // them, and finished rows still lingering. This is the shape the twelve-line
  // overflow logic has to resolve, which the flat "n running" cases never reach.
  const mix = () => makeFleet({ running: 3, queued: 7, finished: 3 });

  const off = track(mountWidget(AgentWidget, mix(), { mode: "background" }));
  bench("3 running / 7 queued / 3 finished — showModel off", () => {
    off.render();
  });

  const on = track(mountWidget(AgentWidget, mix(), { mode: "background", showModel: true }));
  bench("3 running / 7 queued / 3 finished — showModel on", () => {
    on.render();
  });

  const cost = track(mountWidget(AgentWidget, mix(), { mode: "background", showCost: true }));
  bench("3 running / 7 queued / 3 finished — showCost on", () => {
    cost.render();
  });
});
