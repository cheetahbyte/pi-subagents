import { InteractiveMode } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { transcriptOverride } from "../src/ui/transcript-override.js";

type PatchedMode = {
  rebuildChatFromMessages(): void;
};

afterEach(() => transcriptOverride.clear());

describe("transcriptOverride", () => {
  it("renders child messages and restores the parent transcript", () => {
    const rendered: unknown[][] = [];
    const parentEntries = [{ type: "message" }];
    const mode = {
      chatContainer: { clear: vi.fn() },
      pendingTools: new Map([["parent", {}]]),
      sessionManager: { buildContextEntries: () => parentEntries },
      renderSessionEntries: vi.fn(),
      renderSessionItems: (messages: unknown[]) => rendered.push(messages),
    };
    const rebuild = (InteractiveMode.prototype as unknown as PatchedMode).rebuildChatFromMessages;
    rebuild.call(mode);

    let update: ((event: { type: string }) => void) | undefined;
    const childMessages = [{ role: "user", content: "child" }];
    const child = {
      messages: childMessages,
      subscribe: (listener: (event: { type: string }) => void) => {
        update = listener;
        return vi.fn();
      },
    };

    expect(transcriptOverride.show(child as never)).toBe(true);
    expect(rendered.at(-1)).toBe(childMessages);

    update?.({ type: "message_update" });
    expect(rendered).toHaveLength(1);
    update?.({ type: "message_end" });
    expect(rendered).toHaveLength(2);
    expect(mode.pendingTools.has("parent")).toBe(true);

    transcriptOverride.clear();
    expect(mode.renderSessionEntries).toHaveBeenLastCalledWith(parentEntries);
  });
});
