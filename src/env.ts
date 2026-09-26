/**
 * env.ts — Detect environment info (git, platform) for subagent system prompts.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { EnvInfo } from "./types.js";

export async function detectEnv(pi: ExtensionAPI, cwd: string): Promise<EnvInfo> {
  // Both run at once; the branch answer is discarded outside a repo.
  const [repo, current] = await Promise.all([
    pi.exec("git", ["rev-parse", "--is-inside-work-tree"], { cwd, timeout: 5000 }).catch(() => undefined),
    pi.exec("git", ["branch", "--show-current"], { cwd, timeout: 5000 }).catch(() => undefined),
  ]);
  const isGitRepo = repo?.code === 0 && repo.stdout.trim() === "true";
  const branch = !isGitRepo ? "" : current?.code === 0 ? current.stdout.trim() : "unknown";

  return {
    isGitRepo,
    branch,
    platform: process.platform,
  };
}
