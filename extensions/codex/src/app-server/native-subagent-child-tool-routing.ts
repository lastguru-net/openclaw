import { embeddedAgentLog, formatErrorMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import { readStringField as readString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { readCodexNotificationItem } from "./attempt-notifications.js";
import { itemName, nativeToolResultContentSource } from "./event-projector-items.js";
import { releaseNativeChildTools } from "./native-child-tool-custody.js";
import { waitForNativeModelSourceChange } from "./native-subagent-model-lookup.js";
import { notifyNativeModelSourceWaiters } from "./native-subagent-model-source.js";
import type {
  ChildState,
  KnownChild,
  NativeChildAdmissionEvidence,
  NativeChildToolExecutor,
  NativeSubagentMonitorClient,
  ParentOwner,
  ParentState,
} from "./native-subagent-monitor-types.js";
import { readCodexDynamicToolCallParams } from "./protocol-validators.js";
import type {
  CodexDynamicToolCallParams,
  CodexDynamicToolCallResponse,
  CodexServerNotification,
  JsonObject,
} from "./protocol.js";

export type NativeChildToolRoutingContext = {
  knownChildren: ReadonlyMap<string, KnownChild>;
  childStates: ReadonlyMap<string, ChildState>;
  admissions: ReadonlyMap<string, NativeChildAdmissionEvidence[]>;
  currentChild: (threadId: string) => ChildState | undefined;
  isCurrentParent: (state: ParentState) => boolean;
  childAdmissionCancelled: (state: ParentState, owner?: ParentOwner) => boolean;
};

export function createNativeChildToolRequestHandler(
  context: NativeChildToolRoutingContext,
): Parameters<NativeSubagentMonitorClient["addRequestHandler"]>[0] {
  return async (request, requestSignal, setExecutionTimeoutMs) => {
    const signal = requestSignal ?? new AbortController().signal;
    if (request.method !== "item/tool/call") {
      return undefined;
    }
    const call = readCodexDynamicToolCallParams(request.params);
    if (!call) {
      return undefined;
    }
    const known = context.knownChildren.get(call.threadId);
    if (!known) {
      // Foreground and unrelated threads retain their exact-thread handlers.
      return undefined;
    }
    const fail = (text: string): CodexDynamicToolCallResponse => ({
      success: false,
      contentItems: [{ type: "inputText", text }],
    });
    try {
      await waitForChildToolAdmission(context, call, known.parent, signal);
    } catch {
      return fail("OpenClaw native child tool admission was cancelled.");
    }
    if (context.knownChildren.get(call.threadId)?.parent !== known.parent) {
      return fail("OpenClaw native child tool parent changed before admission.");
    }
    const child = context.currentChild(call.threadId);
    const owner = child?.childToolsOwner;
    if (
      !child ||
      !owner ||
      !child.childTools ||
      child.nativeTurnId !== call.turnId ||
      child.nativeTurnState !== "active"
    ) {
      return fail("OpenClaw tools are not admitted for this native child turn.");
    }
    try {
      signal.throwIfAborted();
      assertChildToolAdmission(context, known.parent, child, owner);
    } catch {
      return fail("OpenClaw native child tool authority is no longer current.");
    }
    return child.childTools.handleToolCall(call, signal, setExecutionTimeoutMs);
  };
}

async function waitForChildToolAdmission(
  context: NativeChildToolRoutingContext,
  call: Pick<CodexDynamicToolCallParams, "threadId" | "turnId">,
  state: ParentState,
  signal: AbortSignal,
): Promise<void> {
  for (;;) {
    signal.throwIfAborted();
    const known = context.knownChildren.get(call.threadId);
    const child = context.currentChild(call.threadId);
    if (
      !context.isCurrentParent(state) ||
      known?.parent !== state ||
      known.nativeParentThreadId !== state.parentThreadId
    ) {
      return;
    }
    const active =
      child?.nativeTurnId === call.turnId &&
      child.nativeTurnState === "active" &&
      !child.terminal &&
      !child.settledWithoutCompletion &&
      !child.cancellationRequested;
    if (active && child.childTools) {
      return;
    }
    const queued = known.pendingTurns.find(
      (pending) => pending.turnId === call.turnId && pending.state === "active",
    );
    if (!active && !queued) {
      return;
    }
    const pendingSource =
      queued?.childTools ||
      (!child?.directOwner &&
        [...state.owners.values()].some(
          (owner) =>
            owner.createChildTools &&
            !owner.descendantsCancelled &&
            !owner.childToolsLifetime?.revoked,
        ));
    if (!pendingSource) {
      return;
    }
    // Codex starts the child before publishing its parent's completed spawn item.
    // Observation permits waiting only; that item still owns source admission.
    await waitForNativeModelSourceChange(state, signal);
  }
}

export function observeNativeChildToolContext(
  context: NativeChildToolRoutingContext,
  notification: CodexServerNotification,
  params: JsonObject | undefined,
  threadId: string | undefined,
): void {
  if (notification.method !== "item/completed" || !threadId) {
    return;
  }
  const known = context.knownChildren.get(threadId);
  if (
    !known ||
    !context.isCurrentParent(known.parent) ||
    known.nativeParentThreadId !== known.parent.parentThreadId
  ) {
    return;
  }
  const turnId = readString(params, "turnId");
  if (!turnId) {
    return;
  }
  const child = context.currentChild(threadId);
  const pending = known.pendingTurns.find(
    (entry) => entry.turnId === turnId && entry.state === "active",
  );
  const holder =
    pending ??
    (child &&
    child.nativeTurnId === turnId &&
    child.nativeTurnState === "active" &&
    !child.terminal &&
    !child.settledWithoutCompletion
      ? child
      : undefined);
  const item = readCodexNotificationItem(params);
  if (!holder || !item) {
    return;
  }
  try {
    if (item.type === "contextCompaction") {
      if (item.id) {
        holder.childTools?.observeContextCompaction(item.id);
      }
      return;
    }
    const source = nativeToolResultContentSource(item);
    if (!source || holder.nativeToolOutcome) {
      return;
    }
    // Sticky per native turn, including results observed before executable admission.
    holder.nativeToolOutcome = {
      toolName: itemName(item) ?? item.type,
      argsHash: "",
      resultHash: "",
      resultContentSource: source,
    };
    holder.childTools?.observeToolOutcome(holder.nativeToolOutcome);
  } catch (error) {
    // Lost context/provenance must fail tools closed, not skip native lifecycle handling.
    releaseNativeChildTools(holder);
    embeddedAgentLog.debug("Codex native context lost its child tool authority", {
      error: formatErrorMessage(error),
    });
  }
}

function assertChildToolAdmission(
  context: NativeChildToolRoutingContext,
  state: ParentState,
  child: ChildState,
  owner: ParentOwner,
): void {
  const known = context.knownChildren.get(child.childThreadId);
  if (
    !context.isCurrentParent(state) ||
    context.currentChild(child.childThreadId) !== child ||
    context.childStates.get(child.runId) !== child ||
    known?.parent !== state ||
    known.assignment.runId !== child.runId ||
    known.assignment.terminal ||
    child.nativeParentThreadId !== state.parentThreadId ||
    known.nativeParentThreadId !== state.parentThreadId ||
    (child.childToolsOwner ?? child.directOwner) !== owner ||
    child.terminal ||
    child.settledWithoutCompletion ||
    child.cancellationRequested ||
    (child.nativeTurnState && child.nativeTurnState !== "active") ||
    owner.childToolsLifetime?.revoked ||
    context.childAdmissionCancelled(state, owner)
  ) {
    throw new Error("Codex native child tool admission is no longer current");
  }
}

export function captureAcceptedNativeChildInteractionTools(
  context: NativeChildToolRoutingContext,
  state: ParentState,
  evidence: Extract<NativeChildAdmissionEvidence, { kind: "interaction" }>,
  admissionOwner: ParentOwner,
  parentTurnId: string | undefined,
): void {
  if (evidence.childToolsCaptured) {
    return;
  }
  const foreground = [...state.owners.values()].find(
    (candidate) =>
      candidate === admissionOwner ||
      (candidate.childToolsLifetime &&
        candidate.childToolsLifetime === admissionOwner.childToolsLifetime),
  );
  const inputId = evidence.modelSourceTurnId ?? evidence.itemId;
  if (foreground?.createChildTools && inputId) {
    evidence.childToolsCaptured = true;
    // Operational input attribution, not a native assignment: accepted submission
    // IDs can be opaque and precede the receiver's actual turn ID.
    const identityKind = evidence.modelSourceTurnId ? "submission" : "call";
    captureChildTools(
      context,
      state,
      evidence.childThreadId,
      foreground,
      evidence,
      `codex-native-tool-input:${encodeURIComponent(evidence.childThreadId)}:${identityKind}:${encodeURIComponent(parentTurnId ?? "")}:${encodeURIComponent(inputId)}`,
    );
  }
}

export function createNativeChildTools(
  context: NativeChildToolRoutingContext,
  state: ParentState,
  child: ChildState,
  owner: ParentOwner,
): void {
  captureChildTools(context, state, child.childThreadId, owner, child, child.runId);
}

function captureChildTools(
  context: NativeChildToolRoutingContext,
  state: ParentState,
  threadId: string,
  owner: ParentOwner,
  holder: Pick<ChildState, "childTools" | "childToolsOwner" | "nativeToolOutcome">,
  runId: string,
): void {
  if (holder.childTools || !owner.createChildTools || ![...state.owners.values()].includes(owner)) {
    return;
  }
  const known = context.knownChildren.get(threadId);
  if (known?.parent !== state || known.nativeParentThreadId !== state.parentThreadId) {
    return;
  }
  let initialized = false;
  let disposed = false;
  const assertCurrent = () => {
    const registered = context.knownChildren.get(threadId);
    if (
      disposed ||
      !context.isCurrentParent(state) ||
      registered?.parent !== state ||
      registered.nativeParentThreadId !== state.parentThreadId ||
      owner.childToolsLifetime?.revoked ||
      context.childAdmissionCancelled(state, owner)
    ) {
      throw new Error("Codex native child tool admission is no longer current");
    }
    if (!initialized) {
      return;
    }
    const child = context.currentChild(threadId);
    const active =
      child?.childTools === tools &&
      child.childToolsOwner === owner &&
      !child.terminal &&
      !child.settledWithoutCompletion &&
      !child.cancellationRequested &&
      (!child.nativeTurnState || child.nativeTurnState === "active");
    const queued = registered.pendingTurns.some(
      (pending) =>
        pending.childTools === tools &&
        pending.childToolsOwner === owner &&
        (!pending.state || pending.state === "active"),
    );
    const buffered = [...context.admissions.values()].some((entries) =>
      entries.some(
        (evidence) =>
          evidence.kind === "interaction" &&
          evidence.childThreadId === threadId &&
          evidence.childTools === tools &&
          evidence.childToolsOwner === owner,
      ),
    );
    if (!active && !queued && !buffered) {
      throw new Error("Codex native child tool admission is no longer current");
    }
  };
  assertCurrent();
  const executor = owner.createChildTools({ runId, threadId, assertCurrent });
  const tools: NativeChildToolExecutor = {
    observeContextCompaction: (itemId) => {
      assertCurrent();
      executor.observeContextCompaction(itemId);
    },
    observeToolOutcome: (observation) => {
      assertCurrent();
      executor.observeToolOutcome(observation);
    },
    handleToolCall: (call, signal, setExecutionTimeoutMs) => {
      signal.throwIfAborted();
      assertCurrent();
      return executor.handleToolCall(call, signal, setExecutionTimeoutMs);
    },
    dispose: () => {
      if (!disposed) {
        disposed = true;
        executor.dispose();
      }
    },
  };
  holder.childTools = tools;
  holder.childToolsOwner = owner;
  initialized = true;
  try {
    assertCurrent();
    if (holder.nativeToolOutcome) {
      tools.observeToolOutcome(holder.nativeToolOutcome);
    }
    notifyNativeModelSourceWaiters(state);
  } catch (error) {
    releaseNativeChildTools(holder);
    throw error;
  }
}

export function releaseNativeChildToolsForOwner(
  context: NativeChildToolRoutingContext,
  owner: ParentOwner,
): void {
  for (const child of context.childStates.values()) {
    if (
      owner.childToolsLifetime &&
      child.childToolsOwner?.childToolsLifetime === owner.childToolsLifetime
    ) {
      releaseNativeChildTools(child);
    }
  }
  for (const known of context.knownChildren.values()) {
    for (const pending of known.pendingTurns) {
      if (
        owner.childToolsLifetime &&
        pending.childToolsOwner?.childToolsLifetime === owner.childToolsLifetime
      ) {
        releaseNativeChildTools(pending);
      }
    }
  }
  for (const entries of context.admissions.values()) {
    for (const evidence of entries) {
      if (
        evidence.kind === "interaction" &&
        owner.childToolsLifetime &&
        evidence.childToolsOwner?.childToolsLifetime === owner.childToolsLifetime
      ) {
        releaseNativeChildTools(evidence);
      }
    }
  }
}
