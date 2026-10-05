import type { WorkflowCardLine } from "../../src/ui/workflow-card.ts";

/** A card or dialog layout as plain text — what the layout tests assert against. */
export function plainWorkflowLines(lines: readonly WorkflowCardLine[]): string[] {
  return lines.map(line => line.map(segment => segment.text).join(""));
}
