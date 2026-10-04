/**
 * project-trust.ts — whether project-local subagent files may be read.
 *
 * Mirrors pi's project trust: an untrusted project's `.pi/` and `.agents/`
 * files (agents, `subagents.json`, saved workflows, skills, the custom tool
 * description, `enabledModels`) are skipped and only the user's own apply.
 *
 * Module state because the readers are called from places that hold no
 * ExtensionContext. The extension sets it at activation and again on every
 * `session_start`; `true` is only what a reader used on its own starts from.
 */

let trusted = true;

export function isProjectTrusted(): boolean {
  return trusted;
}

export function setProjectTrusted(value: boolean): void {
  trusted = value;
}
