/**
 * nested-delegation-e2e.test.ts — regression for opt-in nested delegation, run
 * through the real stack: real pi loader + real extension + real runAgent + two
 * real child sessions, on a faux model.
 *
 * Everything else that covers nesting stops short of a real session — the tool
 * unit tests use a fake manager, and the runner tests assert against a mocked
 * pi. That leaves the load-bearing integration facts unproven: that pi actually
 * admits the injected `customTools` into a child session's ACTIVE tool set
 * (they collide with EXCLUDED_TOOL_NAMES by design, so a registry gate could
 * silently drop them), and that a grandchild's output travels back up two hops.
 * Those are exactly the things that break quietly, so they are pinned here.
 *
 * Deliberately faux, not live: `PI_E2E_LIVE=1` cannot drive a three-level chain
 * deterministically, and a live model choosing not to delegate would look like
 * a passing test. Each run therefore pins `live: false` rather than trusting the
 * env var to leave it alone — the pre-publish smoke sets it globally.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Context, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerAgents } from "../src/agent-types.js";
import { loadCustomAgents } from "../src/custom-agents.js";
import { encodeCwd } from "../src/output-file.js";
import {
  agentCall,
  type FauxReply,
  type PrintModeRun,
  runPrintMode,
} from "./helpers/print-mode-runner.js";

vi.setConfig({ testTimeout: 30_000 });

/** Marker the deepest agent emits — it must survive two hops back to the parent. */
const WORKER_MARKER = "WORKER-REACHED-THE-TOP";

/** First user message of a session — the only stable way to tell three faux sessions apart. */
function firstUserText(context: Context): string {
  const first = context.messages.find((m) => m.role === "user");
  const content = first?.content;
  if (typeof content === "string") return content;
  return ((content ?? []) as Array<{ text?: string }>).map((b) => b.text ?? "").join("");
}

/** Tool results in a session context, newest last, with their tool names. */
function toolResultTexts(context: Context): Array<{ name: string; text: string }> {
  const out: Array<{ name: string; text: string }> = [];
  for (const m of context.messages) {
    if (m.role !== "toolResult") continue;
    const name = (m as { toolName?: string }).toolName ?? "";
    const text = ((m.content ?? []) as Array<{ text?: string }>).map((b) => b.text ?? "").join("");
    out.push({ name, text });
  }
  return out;
}

/** Every `.output` transcript beneath a root, at any session/tasks depth. */
function findOutputFiles(root: string): string[] {
  let entries: string[];
  try { entries = readdirSync(root); } catch { return []; }
  return entries.flatMap((e) => {
    const full = join(root, e);
    if (statSync(full).isDirectory()) return findOutputFiles(full);
    return full.endsWith(".output") ? [full] : [];
  });
}

function writeAgents(cwd: string): void {
  const dir = join(cwd, ".pi", "agents");
  mkdirSync(dir, { recursive: true });
  // Opts into nesting, restricted to one type — the allowlist path, not `all`.
  writeFileSync(
    join(dir, "orchestrator.md"),
    "---\ndescription: Delegating orchestrator\ntools: read\nextensions: false\nallowed_subagents: worker\n---\nDelegate to worker.\n",
  );
  writeFileSync(
    join(dir, "worker.md"),
    "---\ndescription: Leaf worker\ntools: read\nextensions: false\n---\nDo the work.\n",
  );
}

/** The same agents, plus a delegating parent and a leaf kid for the question round trip. */
function writeQuestionAgents(cwd: string): void {
  writeAgents(cwd);
  const dir = join(cwd, ".pi", "agents");
  writeFileSync(
    join(dir, "parent.md"),
    "---\ndescription: Questionable parent\ntools: read\nextensions: false\nallowed_subagents: kid\n---\nDelegate to kid.\n",
  );
  writeFileSync(
    join(dir, "kid.md"),
    "---\ndescription: Leaf kid\ntools: read\nextensions: false\n---\nDo the work.\n",
  );
}

describe("nested delegation e2e (real pi-mono, faux model)", () => {
  let run: PrintModeRun | undefined;
  const tmpDirs: string[] = [];

  afterEach(async () => {
    await run?.dispose();
    run = undefined;
    for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("a child with allowed_subagents spawns its own child, and the output travels back up", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "nested-e2e-"));
    tmpDirs.push(cwd);
    writeAgents(cwd);

    /** Tool names each session was actually offered, keyed by who it is. */
    const toolsSeen = new Map<string, string[]>();

    const respond = (context: Context): FauxReply => {
      const text = firstUserText(context);
      const names = (context.tools ?? []).map((t) => t.name);

      // Leaf: no nested tools (it never opted in) — just answer.
      if (text.includes("Do the leaf work")) {
        toolsSeen.set("worker", names);
        return WORKER_MARKER;
      }

      // Middle: opted in, so pi must have admitted the injected Agent tool.
      if (text.includes("Delegate this downward")) {
        toolsSeen.set("orchestrator", names);
        const alreadySpawned = context.messages.some(
          (m) => m.role === "toolResult" && (m as { toolName?: string }).toolName === "Agent",
        );
        if (alreadySpawned) {
          const result = [...context.messages]
            .reverse()
            .find((m) => m.role === "toolResult" && (m as { toolName?: string }).toolName === "Agent");
          const inner = ((result?.content ?? []) as Array<{ text?: string }>)
            .map((b) => b.text ?? "")
            .join("");
          // Echo the child's own text: if it never arrived, the marker is absent
          // and the top-level assertion fails rather than passing vacuously.
          return `orchestrator saw: ${inner}`;
        }
        return agentCall({
          subagent_type: "worker",
          description: "leaf work",
          prompt: "Do the leaf work.",
        });
      }

      // Top-level parent.
      toolsSeen.set("parent", names);
      const spawned = context.messages.some(
        (m) => m.role === "toolResult" && (m as { toolName?: string }).toolName === "Agent",
      );
      if (spawned) {
        const result = [...context.messages]
          .reverse()
          .find((m) => m.role === "toolResult" && (m as { toolName?: string }).toolName === "Agent");
        const inner = ((result?.content ?? []) as Array<{ text?: string }>)
          .map((b) => b.text ?? "")
          .join("");
        return `parent saw: ${inner}`;
      }
      return agentCall({
        subagent_type: "orchestrator",
        description: "delegate",
        prompt: "Delegate this downward.",
        // Foreground: this test reads the parent's inline Agent tool result.
        run_in_background: false,
      });
    };

    run = await runPrintMode({
      prompt: "Delegate the work.",
      cwd,
      respond,
      live: false,
      beforeRun: () => { registerAgents(loadCustomAgents(cwd)); },
    });

    // pi admitted the injected nested tools into the opted-in child's active set,
    // despite their names colliding with the ones stripped from every subagent.
    expect(toolsSeen.get("orchestrator")).toContain("Agent");
    expect(toolsSeen.get("orchestrator")).toContain("get_subagent_result");
    expect(toolsSeen.get("orchestrator")).toContain("steer_subagent");

    // The leaf never opted in, so it must not have them.
    expect(toolsSeen.get("worker")).toBeDefined();
    expect(toolsSeen.get("worker")).not.toContain("Agent");

    // Two hops home: worker → orchestrator → parent.
    expect(run.responseText).toContain(WORKER_MARKER);
  });

  it("a background nested child asks its immediate parent, stays blocked, and continues its turn once answered", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "nested-e2e-q-"));
    tmpDirs.push(cwd);
    writeQuestionAgents(cwd);

    const toolsSeen = new Map<string, string[]>();
    const KID_CONTINUED = "KID-CONTINUED-WITH:";

    const respond = (context: Context): FauxReply => {
      const text = firstUserText(context).toLowerCase();
      const names = (context.tools ?? []).map((t) => t.name);
      const results = toolResultTexts(context);
      const userText = [...context.messages]
        .filter((m) => m.role === "user")
        .flatMap((m) => (m.content as Array<{ text?: string }>).map((b) => b.text ?? ""))
        .join("\n");

      // KID — a leaf backgrounded under the parent. It asks, then its ask_parent
      // call blocks until the parent answers; only then does this turn run again.
      if (text.includes("ask my parent a question")) {
        toolsSeen.set("kid", names);
        const asked = results.find((r) => r.name === "ask_parent");
        if (asked) {
          // Reachable ONLY if ask_parent resolved — i.e. the parent answered and
          // the blocked child was not torn down. The answer rides the marker.
          return `${KID_CONTINUED} ${asked.text}`;
        }
        return fauxToolCall("ask_parent", { question: "Which repo is this codebase?" });
      }

      // BELL — a second leaf the parent parks on. The faux model answers
      // instantly, so a parent that keeps turning starves its background
      // children; parking on a blocking `wait: true` poll is what lets the kid
      // run — and ask — while the parent stays alive and answerable.
      if (text.includes("ring the bell")) return "BELL-DONE";

      // PARENT — a nested agent that owns the kid. It spawns the kid plus a
      // bell in the background (one per turn, so the two spawn envelopes are
      // never racy), parks on the bell until it rings (the faux model answers
      // instantly, so parking is what lets the background children actually
      // run), answers the kid's question through answer_subagent_question, then
      // polls the kid's result so the continued turn travels back up. It never
      // returns a final text turn while the kid is outstanding — a parent that
      // settled would be marked completed and its background child aborted, an
      // orphan the manager deliberately does not keep alive.
      if (text.includes("run the question round trip")) {
        toolsSeen.set("parent", names);
        // Envelopes arrive in spawn order: kid first, bell second.
        const agentIds = results
          .filter((r) => r.name === "Agent")
          .map((r) => /Agent ID:\s*(\S+)/.exec(r.text)?.[1] ?? "");
        const kidId = agentIds[0];
        const bellId = agentIds[1];
        const kidDone = results.find(
          (r) => r.name === "get_subagent_result" && r.text.includes(KID_CONTINUED),
        );
        if (kidDone) return `parent saw kid continue: ${kidDone.text}`;
        const answered = results.some(
          (r) => r.name === "answer_subagent_question" && r.text.includes("Answer delivered"),
        );
        const bellDone = results.some(
          (r) => r.name === "get_subagent_result" && r.text.includes("BELL-DONE"),
        );
        const steerPresent = userText.includes("answer_subagent_question");
        if (answered && kidId) {
          return fauxToolCall("get_subagent_result", { agent_id: kidId, wait: true });
        }
        if (bellDone && steerPresent && kidId) {
          const qid = /question id "([^"]+)"/.exec(userText)?.[1];
          expect(qid).toBeTruthy();
          return fauxToolCall("answer_subagent_question", { question_id: qid, answer: "faux-repo" });
        }
        if (kidId && bellId) {
          return fauxToolCall("get_subagent_result", { agent_id: bellId, wait: true });
        }
        if (agentIds.length === 1) {
          return agentCall({
            subagent_type: "kid",
            description: "ring a bell",
            prompt: "Ring the bell then stop.",
            run_in_background: true,
          });
        }
        return agentCall({
          subagent_type: "kid",
          description: "ask a question",
          prompt: "Ask my parent a question and report its answer.",
          run_in_background: true,
        });
      }

      // ROOT — the print-mode host. Foreground-spawns the parent so the whole
      // chain settles before it turns again.
      toolsSeen.set("root", names);
      const agentResult = results.find((r) => r.name === "Agent")?.text ?? "";
      if (agentResult) return `root heard: ${agentResult}`;
      return agentCall({
        subagent_type: "parent",
        description: "delegate question round trip",
        prompt: "Run the question round trip.",
        run_in_background: false,
      });
    };

    run = await runPrintMode({
      prompt: "Delegate the question round trip.",
      cwd,
      respond,
      live: false,
      maxModelCalls: 30,
      beforeRun: () => { registerAgents(loadCustomAgents(cwd)); },
    });

    // The leaf kid can ask (ask_parent is injected into every child) but never
    // spawns (no allowed_subagents, and it sits at the depth cap).
    expect(toolsSeen.get("kid")).toEqual(expect.arrayContaining(["ask_parent"]));
    expect(toolsSeen.get("kid")).not.toContain("Agent");
    // The nested parent owns the answer side.
    expect(toolsSeen.get("parent")).toEqual(expect.arrayContaining(["answer_subagent_question"]));

    // The load-bearing fact: the child's ask_parent was answered through
    // answer_subagent_question and its turn continued — the answer "faux-repo"
    // survives kid → parent → root in the marker. If the question had been
    // dropped, answered by the wrong responder, or the child torn down while
    // blocked, no marker would exist.
    expect(run.responseText).toContain("KID-CONTINUED-WITH: faux-repo");
  });

  it("backgrounds a nested child, polls it by id, and streams its transcript", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "nested-e2e-bg-"));
    tmpDirs.push(cwd);
    writeAgents(cwd);
    const transcriptRoot = join(tmpdir(), `pi-subagents-${process.getuid?.() ?? 0}`, encodeCwd(cwd));
    rmSync(transcriptRoot, { recursive: true, force: true });

    const respond = (context: Context): FauxReply => {
      const text = firstUserText(context);

      if (text.includes("Do the leaf work")) return WORKER_MARKER;

      if (text.includes("Delegate this downward")) {
        const results = toolResultTexts(context);
        const spawned = results.find((r) => r.name === "Agent")?.text ?? "";
        const polled = results.find((r) => r.name === "get_subagent_result")?.text;
        // Third turn: the poll came back — echo it so a lost result fails loudly.
        if (polled !== undefined) return `orchestrator polled: ${polled}`;
        // Second turn: the spawn returned an id; fetch by exactly that id, which
        // also exercises the manager's ownership check from inside a child.
        if (spawned) {
          const id = /Agent ID:\s*(\S+)/.exec(spawned)?.[1];
          expect(id).toBeTruthy();
          return fauxToolCall("get_subagent_result", { agent_id: id, wait: true });
        }
        return agentCall({
          subagent_type: "worker",
          description: "leaf work",
          prompt: "Do the leaf work.",
          run_in_background: true,
        });
      }

      if (toolResultTexts(context).some((r) => r.name === "Agent")) return "parent done";
      return agentCall({
        subagent_type: "orchestrator",
        description: "delegate",
        prompt: "Delegate this downward.",
        // Foreground: this test reads the parent's inline Agent tool result.
        run_in_background: false,
      });
    };

    try {
      run = await runPrintMode({
        prompt: "Delegate the work.",
        cwd,
        respond,
        live: false,
        beforeRun: () => { registerAgents(loadCustomAgents(cwd)); },
      });

      // The background child ran and its output came back through the id the
      // spawn handed out — so it was never queued behind its waiting parent.
      const orchestratorResult = run.parentSession.messages
        .filter((m) => m.role === "toolResult")
        .flatMap((m) => (m.content as Array<{ text?: string }>).map((b) => b.text ?? ""))
        .join("\n");
      expect(orchestratorResult).toContain("orchestrator polled");
      expect(orchestratorResult).toContain(WORKER_MARKER);

      // Only the REAL manager wires onSessionCreated → streamToOutputFile for a
      // nested spawn, and only real rootSessionId propagation puts the file under
      // this root. Identify the WORKER's own transcript by the prompt in its
      // initial entry — matching the marker alone would also match the
      // orchestrator's transcript, which merely echoes it, and would pass even
      // with nested transcripts switched off entirely.
      // Match on the FIRST line — writeInitialEntry seeds each transcript with the
      // prompt that agent was given. Searching the whole file would also match the
      // orchestrator's, which records the same string inside its Agent tool-call
      // arguments, and would pass with nested transcripts switched off entirely.
      const transcripts = findOutputFiles(transcriptRoot).map((f) => readFileSync(f, "utf-8"));
      const workerTranscript = transcripts.find((t) => {
        const first = JSON.parse(t.split("\n")[0]) as { message?: { content?: unknown } };
        return first.message?.content === "Do the leaf work.";
      });
      expect(workerTranscript).toBeDefined();
      // ...and it streamed the child's own turn, not just the seeded prompt.
      expect(workerTranscript).toContain(WORKER_MARKER);
    } finally {
      rmSync(transcriptRoot, { recursive: true, force: true });
    }
  });
});
