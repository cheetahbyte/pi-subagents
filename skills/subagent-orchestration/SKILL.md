---
name: subagent-orchestration
description: Delegate substantial tasks with pi-subagents. Use when splitting independent work across agents, briefing a specialist, or coordinating dependent research, implementation, and verification stages.
---

# Subagent orchestration

Use the tools and agent types advertised in this session. Their descriptions define the current parameters and capabilities; this playbook guides task ownership and integration. If `Agent` is unavailable, work directly rather than assuming this skill enables delegation.

## Choose the smallest useful delegation

- Use direct tools for a known file, a specific symbol lookup, or a small local change.
- Use `Agent` for a bounded investigation or implementation that benefits from a specialist or can run independently of your work.
- Send a few independent tasks as multiple `Agent` calls in one message.
- Use `SubagentWorkflow`, when available, for runtime-discovered fan-out or repeated dependent stages. Before writing a script, read the [workflow guide](../../docs/workflows.md). A single research-then-edit task usually needs only an `Agent` call and your own follow-up.

Delegate once you can state the question and its boundary. Read enough to define that boundary, rather than completing the investigation before handing it off.

## Assign ownership

Give each agent one deliverable and a clear read-only or editing scope. Select its type from the live roster based on its advertised capabilities.

For parallel edits, assign disjoint files and agree on shared interfaces first. Keep shared configuration, dependency files, and cross-cutting integration under one owner. If the boundaries are unclear, serialize the edits. You must also stay outside another agent's editing scope while it works.

For worktree isolation, first read the [worktree reference](../../README.md#worktree-isolation). Worktrees omit the main checkout's uncommitted changes and automatically commit changed work to a branch. Use them only when those side effects are authorized; they are unsuitable for reviewing an uncommitted diff. Inspect the returned branch before integrating it.

Delegation preserves the user's scope and approval requirements. Explicitly pass relevant restrictions to the child, including restrictions on commits, secrets, and external actions. A separate agent session is not a security sandbox.

## Brief the agent

Write a self-contained prompt with:

- **Goal:** the outcome and why it matters.
- **Known findings:** relevant paths, searches already run, conclusions, and remaining uncertainty.
- **Ownership:** files it may edit, or an explicit read-only instruction; identify work owned elsewhere.
- **Acceptance:** observable behavior and required checks, or the evidence needed to answer an investigation.
- **Return format:** findings with locations, or changed files and actual check results; include blockers and unresolved questions.

For investigations, supply the question without pretending to know the answer. For implementation, supply the agreed behavior and constraints. Pass focused context rather than the entire conversation unless its history is necessary.

## Coordinate and verify

Choose foreground execution when your next action depends on the answer; otherwise use background execution for independent work. Follow the tool's current waiting and notification contract. While an agent investigates, work on a different task or yield instead of repeating its searches.

Use `steer_subagent` to correct an active task's scope. For a follow-up after completion, reuse its context through `resume` when you have its returned ID. If a child asks a question, answer through the available question tool; escalate decisions outside your authority to the user.

Before declaring completion, retrieve any result detail needed beyond the notification preview, inspect the actual changes or cited evidence, and run the project's required checks against the integrated state. Distinguish failed or partial runs from completed work. Resolve conflicting findings against the source or a reproducible check, not by counting agreeing agents. Report verified outcomes and remaining gaps to the user.

## Example: parallel read-only investigation

Task: determine whether an authentication change breaks clients.

Assign one agent to trace server-side token validation and another to inspect client token refresh behavior. Both are read-only; each returns paths, relevant conditions, and evidence for incompatibilities. Include the changed entry points and searches already performed in each brief. While they run, inspect release constraints rather than retracing either path. Compare both results before proposing a fix.

## Example: implementation after research

Task: fix cancellation leaving a request pending.

Ask one agent to trace cancellation from the public entry point to cleanup, returning the missing transition and a reproduction without editing files. Use foreground execution if that answer gates your next step. After inspecting the cited code, implement directly if the fix is small. If delegation is still useful, give an editing agent the confirmed behavior, owned files, and regression-check requirement. Inspect its diff and run the required checks before reporting the fix.
