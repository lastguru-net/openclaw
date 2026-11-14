import type { AgentHarnessCompletionCustody } from "openclaw/plugin-sdk/agent-harness-completion";
import { releaseNativeChildTools, transferNativeChildTools } from "./native-child-tool-custody.js";
import { releaseCompletionCustody } from "./native-subagent-admission-custody.js";
import {
  codexNativeSubagentRunId,
  type NativeSubagentAssignment,
} from "./native-subagent-assignment.js";
import {
  notifyNativeModelSourceWaiters,
  releaseNativeDirectChild,
  releaseNativeModelExecution,
} from "./native-subagent-model-source.js";
import type {
  ChildState,
  KnownChild,
  NativeChildAdmissionEvidence,
  ParentOwner,
  ParentState,
} from "./native-subagent-monitor-types.js";

type FollowupAdmissionDependencies = {
  parents: ReadonlyMap<string, ParentState>;
  retiredParents: Pick<WeakSet<ParentState>, "has">;
  admissions: ReadonlyMap<string, NativeChildAdmissionEvidence[]>;
  currentChild: (threadId: string) => ChildState | undefined;
  childAdmissionCancelled: (state: ParentState, owner?: ParentOwner) => boolean;
  registerChild: (
    state: ParentState,
    assignment: NativeSubagentAssignment,
    options: { admitAssignment: true; completionCustody?: AgentHarnessCompletionCustody },
  ) => ChildState | undefined;
  recordAssignment: (state: ParentState, child: ChildState) => void;
  applyReceipts: (state: ParentState, runIds: readonly string[]) => void;
  createChildTools: (state: ParentState, child: ChildState, owner: ParentOwner) => void;
  observeActiveChild: (child: ChildState) => void;
  bindEventSink: (child: ChildState) => void;
};

// Promotion moves existing pending custody into the monitor's registered assignment.
// It never creates an independent child inventory or authorizes an observed turn alone.
export function admitNativeFollowupChild(
  known: KnownChild,
  owner: ParentOwner | undefined,
  dependencies: FollowupAdmissionDependencies,
): ChildState | undefined {
  const threadId = known.assignment.childThreadId;
  if (
    dependencies.parents.get(known.parent.parentThreadId) !== known.parent ||
    dependencies.retiredParents.has(known.parent)
  ) {
    return undefined;
  }
  let child = dependencies.currentChild(threadId);
  if (!child && !known.assignment.terminal) {
    return undefined;
  }
  let claimOwner = owner;
  let transitioned = false;
  while (known.pendingTurns.length > 0) {
    const pending = known.pendingTurns[0]!;
    const currentTurnId = child?.nativeTurnId;
    const recoveredIndex = currentTurnId
      ? known.pendingTurns.findIndex((candidate) => candidate.turnId === currentTurnId)
      : -1;
    if (
      child &&
      !child.terminal &&
      !known.assignment.terminal &&
      (recoveredIndex >= 0 || child.nativeTurnState === "interrupted")
    ) {
      // History may traverse several interrupted continuations at once. Remove
      // every covered provisional boundary before any receipt matching resumes.
      let continuationCount = Math.max(1, recoveredIndex + 1);
      if (recoveredIndex < 0) {
        while (
          continuationCount < known.pendingTurns.length &&
          known.pendingTurns[continuationCount - 1]?.state === "interrupted"
        ) {
          continuationCount += 1;
        }
      }
      const resumed = known.pendingTurns[continuationCount - 1]!;
      const resumedOwner = resumed.modelSource?.owner ?? resumed.admittedOwner;
      if (dependencies.childAdmissionCancelled(known.parent, resumedOwner)) {
        return undefined;
      }
      const continuations = known.pendingTurns.splice(0, continuationCount);
      child.requesterTurnRunId = resumedOwner?.requesterTurnRunId;
      child.requestCustody = resumedOwner?.requestCustody;
      child.cancelProcesses = resumedOwner?.cancelChildProcesses;
      child.cancellationRequested = undefined;
      child.terminalHandling = undefined;
      child.completionCustody ??= resumed.completionCustody?.retain();
      if (recoveredIndex < 0) {
        child.nativeTurnId = resumed.turnId;
        child.nativeTurnState = resumed.state;
        child.nativeToolOutcome = resumed.nativeToolOutcome;
        child.activityWait = undefined;
      }
      takePendingChildTools(known, child, resumed);
      continuations.forEach((continuation) => releasePendingNativeChildTurn(continuation));
      claimOwner = resumed.admittedOwner;
      if (resumed.modelSource) {
        releaseNativeModelExecution(child);
        child.modelExecution = resumed.modelSource;
        resumed.modelSource = undefined;
      }
      for (const continuation of continuations) {
        continuation.modelSource?.release();
      }
      transitioned = true;
      dependencies.applyReceipts(
        known.parent,
        known.deliveryReceipts.resumeAssignment(
          child.runId,
          continuations.map((turn) => codexNativeSubagentRunId(threadId, turn.turnId)),
        ),
      );
      continue;
    }
    if (
      child &&
      !child.terminal &&
      !known.assignment.terminal &&
      child.nativeTurnState !== "completed" &&
      child.nativeTurnState !== "failed"
    ) {
      child.nativeTurnState = undefined;
      return undefined;
    }
    if (!pending.admittedOwner && !pending.admittedSubmission && !pending.modelSource) {
      return undefined;
    }
    const pendingOwner = pending.modelSource?.owner ?? pending.admittedOwner;
    if (dependencies.childAdmissionCancelled(known.parent, pendingOwner)) {
      return undefined;
    }
    const runId = codexNativeSubagentRunId(threadId, pending.turnId);
    child = dependencies.registerChild(
      known.parent,
      { runId, childThreadId: threadId, nativeTurnId: pending.turnId },
      {
        admitAssignment: true,
        completionCustody: pending.completionCustody,
      },
    );
    if (!child) {
      return undefined;
    }
    child.nativeTurnId = pending.turnId;
    child.nativeTurnState = pending.state;
    child.requesterTurnRunId = pendingOwner?.requesterTurnRunId;
    child.requestCustody = pendingOwner?.requestCustody;
    child.cancelProcesses = pendingOwner?.cancelChildProcesses;
    if (pending.modelSource) {
      releaseNativeModelExecution(child);
      child.modelExecution = pending.modelSource;
      pending.modelSource = undefined;
    }
    claimOwner = pending.admittedOwner;
    transitioned = true;
    takePendingChildTools(known, child, pending);
    known.pendingTurns.shift();
    releasePendingNativeChildTurn(pending);
  }
  if (!child || child.terminal || known.assignment.terminal || !child.nativeTurnId) {
    return undefined;
  }
  dependencies.recordAssignment(known.parent, child);
  known.assignment.nativeTurnId = child.nativeTurnId;
  known.turnId = child.nativeTurnId;
  if (child.nativeTurnState !== "active") {
    return child;
  }
  const currentInteraction = [...dependencies.admissions.values()]
    .flat()
    .findLast(
      (evidence) =>
        evidence.kind === "interaction" &&
        evidence.parentThreadId === known.parent.parentThreadId &&
        evidence.childThreadId === threadId &&
        !evidence.nativeTurnId &&
        evidence.owner &&
        [...known.parent.owners.values()].includes(evidence.owner),
    );
  if (currentInteraction?.kind === "interaction" && currentInteraction.owner) {
    claimOwner = currentInteraction.owner;
  }
  if (claimOwner && [...known.parent.owners.values()].includes(claimOwner)) {
    if (dependencies.childAdmissionCancelled(known.parent, claimOwner)) {
      return undefined;
    }
    child.requesterTurnRunId = claimOwner.requesterTurnRunId;
    child.requestCustody = claimOwner.requestCustody;
    child.cancelProcesses = claimOwner.cancelChildProcesses;
    child.completionCustody ??= claimOwner.completionCustody?.retain();
    if (child.directOwner !== claimOwner) {
      const captured = {
        childTools: child.childTools,
        childToolsOwner: child.childToolsOwner,
      };
      // Hook input ownership may move before the receiver starts another turn.
      // Park the grant without observing outcomes until its registered holder is
      // restored: a temporary holder cannot authenticate executable authority.
      child.childTools = undefined;
      child.childToolsOwner = undefined;
      releaseNativeDirectChild(child);
      child.directOwner = claimOwner;
      child.releaseDirectChild = claimOwner.claimDirectChild?.(child.childThreadId);
      if (captured.childTools) {
        transferNativeChildTools(captured, child);
      } else {
        dependencies.createChildTools(known.parent, child, claimOwner);
      }
    }
    if (!transitioned) {
      claimOwner.onDirectChildAccepted?.();
    }
  }
  dependencies.observeActiveChild(child);
  dependencies.bindEventSink(child);
  return child;
}

function takePendingChildTools(
  known: KnownChild,
  child: ChildState,
  pending: KnownChild["pendingTurns"][number],
): void {
  transferNativeChildTools(pending, child);
  notifyNativeModelSourceWaiters(known.parent);
}

export function releasePendingNativeChildTurn(pending: KnownChild["pendingTurns"][number]): void {
  releaseNativeChildTools(pending);
  releaseCompletionCustody(pending);
}
