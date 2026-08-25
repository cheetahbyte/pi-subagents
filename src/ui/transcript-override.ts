import { type AgentSession, InteractiveMode } from "@earendil-works/pi-coding-agent";

// Pi has no public transcript-view API. Keep this private compatibility patch
// isolated here; FleetList falls back to ConversationViewer when capture fails.

type InteractiveModePrivate = {
  chatContainer: { clear(): void };
  pendingTools: Map<string, unknown>;
  rebuildChatFromMessages(): void;
  renderSessionItems(messages: AgentSession["messages"]): void;
  handleEvent(event: { type?: string }): Promise<void>;
};

type PatchState = {
  mode?: InteractiveModePrivate;
  session?: AgentSession;
  unsubscribe?: () => void;
  originalRebuild: InteractiveModePrivate["rebuildChatFromMessages"];
  originalRenderSessionItems: InteractiveModePrivate["renderSessionItems"];
  originalHandleEvent: InteractiveModePrivate["handleEvent"];
};

export type TranscriptOverride = {
  show(session: AgentSession): boolean;
  clear(): void;
};

const PATCH_KEY = Symbol.for("@tintinweb/pi-subagents/transcript-override-v2");
const prototype = InteractiveMode.prototype as unknown as InteractiveModePrivate & Record<PropertyKey, unknown>;
let state = prototype[PATCH_KEY] as PatchState | undefined;

function renderChild(patch: PatchState): void {
  const { mode, session } = patch;
  if (!mode || !session) return;
  const parentPendingTools = [...mode.pendingTools];
  mode.chatContainer.clear();
  mode.renderSessionItems(session.messages);
  mode.pendingTools.clear();
  for (const entry of parentPendingTools) mode.pendingTools.set(...entry);
}

function rebuild(patch: PatchState): void {
  if (!patch.mode) return;
  if (patch.session) renderChild(patch);
  else patch.originalRebuild.call(patch.mode);
}

if (
  !state
  && typeof prototype.rebuildChatFromMessages === "function"
  && typeof prototype.renderSessionItems === "function"
  && typeof prototype.handleEvent === "function"
) {
  state = {
    originalRebuild: prototype.rebuildChatFromMessages,
    originalRenderSessionItems: prototype.renderSessionItems,
    originalHandleEvent: prototype.handleEvent,
  };
  prototype[PATCH_KEY] = state;
  prototype.renderSessionItems = function patchedRenderSessionItems(this: InteractiveModePrivate, messages): void {
    const patch = state;
    if (!patch) return;
    patch.mode = this;
    if (patch.session && messages !== patch.session.messages) return;
    patch.originalRenderSessionItems.call(this, messages);
  };
  prototype.rebuildChatFromMessages = function patchedRebuild(this: InteractiveModePrivate): void {
    const patch = state;
    if (!patch) return;
    patch.mode = this;
    if (patch.session) renderChild(patch);
    else patch.originalRebuild.call(this);
  };
  prototype.handleEvent = async function patchedHandleEvent(this: InteractiveModePrivate, event): Promise<void> {
    const patch = state;
    if (!patch) return;
    await patch.originalHandleEvent.call(this, event);
    if (
      patch.session
      && patch.mode === this
      && event.type !== "message_update"
      && event.type !== "tool_execution_update"
    ) renderChild(patch);
  };
}

export const transcriptOverride: TranscriptOverride = {
  show(session) {
    if (!state?.mode) return false;
    state.unsubscribe?.();
    state.session = session;
    state.unsubscribe = session.subscribe(event => {
      if (state && (event.type === "message_end" || event.type === "agent_end")) rebuild(state);
    });
    rebuild(state);
    return true;
  },
  clear() {
    if (!state) return;
    state.unsubscribe?.();
    state.unsubscribe = undefined;
    if (!state.session) return;
    state.session = undefined;
    rebuild(state);
  },
};
