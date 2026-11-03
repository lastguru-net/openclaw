import { setImmediate as yieldImmediate } from "node:timers/promises";
import { expect, it, onTestFinished, vi } from "vitest";
import { readAttemptTerminal } from "./attempt-terminal.test-helper.js";
import { TURN_TERMINAL_SETTLEMENT_TIMEOUT_MS } from "./attempt-timeouts.js";
import { createDynamicToolCall, textToolResult } from "./dynamic-tools.test-support.js";
import { setCodexTestToolFactory } from "./host-capability.test-support.js";
import { turnCompleted } from "./protocol.test-helpers.js";
import {
  createTerminalReleaseHarness,
  dynamicToolResult,
  terminalYieldResult,
} from "./run-attempt-lifecycle-controller.test-harness.js";
import {
  bindProductionHarnessHostCapabilitiesForTest,
  createTestParams,
  createCodexRuntimePlanFixture,
  createRuntimeDynamicTool,
  createStartedThreadHarness,
  runCodexAppServerAttempt,
  setCodexTestModelSupportsTools,
  setupRunAttemptTestHooks,
} from "./run-attempt-test-harness.js";

setupRunAttemptTestHooks();

it.each(["explicit", "omitted", "cancel", "timeout", "failed"] as const)(
  "awaits the native outcome after final delivery (%s)",
  async (outcome) => {
    const abort = new AbortController();
    const deadlineChanged = vi.fn();
    const params = Object.assign(createTestParams(), {
      runtimePlan: createCodexRuntimePlanFixture(),
      timeoutMs: 60_000,
      abortSignal: abort.signal,
      onAttemptDeadlineChanged: deadlineChanged,
      sourceReplyDeliveryMode: "automatic" as const,
    });
    const message = createRuntimeDynamicTool("message");
    message.parameters = {
      type: "object",
      properties: {
        action: { type: "string" },
        message: { type: "string" },
        final: { type: "boolean" },
      },
      required: ["action", "message"],
      additionalProperties: false,
    };
    message.execute = vi.fn(async () =>
      textToolResult("Sent.", {
        messageDelivery: {
          status: "settled",
          partialDelivery: false,
          createdThreadIds: [],
          sourceReplyDelivered: true,
        },
      }),
    );
    setCodexTestToolFactory(params, () => [message]);
    setCodexTestModelSupportsTools(params, true);
    onTestFinished(await bindProductionHarnessHostCapabilitiesForTest(params));
    const harness = createStartedThreadHarness(async (method) => {
      if (method === "turn/interrupt") {
        setImmediate(
          () => void harness.notify(turnCompleted({ id: "turn-1", status: "interrupted" })),
        );
        return {};
      }
      return undefined;
    });
    vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
    const run = runCodexAppServerAttempt(params);
    let settled = false;
    void run.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    try {
      await run.waitForTurnAccepted();
      // Delivery just before the execution deadline must get the existing
      // settlement budget, not be demoted to an execution timeout.
      await vi.advanceTimersByTimeAsync(59_900);
      await expect(
        harness.handleServerRequest({
          id: "send",
          method: "item/tool/call",
          params: createDynamicToolCall("message", {
            action: "send",
            message: "Delivered answer",
            ...(outcome === "omitted" ? {} : { final: true }),
          }),
        }),
      ).resolves.toEqual({ success: true, contentItems: [{ type: "inputText", text: "Sent." }] });
      await yieldImmediate();
      expect(message.execute).toHaveBeenCalledOnce();
      expect(settled).toBe(false);
      expect(harness.requests.filter(({ method }) => method === "turn/interrupt")).toEqual([]);
      expect(deadlineChanged).toHaveBeenLastCalledWith({
        kind: "bounded",
        deadlineAtMs: Date.now() + TURN_TERMINAL_SETTLEMENT_TIMEOUT_MS,
      });

      if (outcome === "cancel" || outcome === "timeout") {
        if (outcome === "cancel") {
          abort.abort("user stopped the run");
        } else {
          await vi.advanceTimersByTimeAsync(TURN_TERMINAL_SETTLEMENT_TIMEOUT_MS);
        }
        await harness.waitForMethod("turn/interrupt");
        const result = await run;
        expect(readAttemptTerminal(result)).toMatchObject(
          outcome === "cancel"
            ? { aborted: true, timedOut: false }
            : { timedOut: true, promptError: "codex app-server terminal settlement timed out" },
        );
        expect(result.sourceReplyDelivered).toBe(true);
        expect(harness.requests.filter(({ method }) => method === "turn/interrupt")).toHaveLength(
          1,
        );
      } else if (outcome === "failed") {
        await harness.notify(
          turnCompleted({
            id: "turn-1",
            status: "failed",
            error: { message: "Native provider failed after delivery" },
          }),
        );
        const result = await run;
        expect(readAttemptTerminal(result)).toMatchObject({
          aborted: false,
          timedOut: false,
          promptError: "Native provider failed after delivery",
        });
        expect(result.sourceReplyDelivered).toBe(true);
        expect(harness.requests.filter(({ method }) => method === "turn/interrupt")).toEqual([]);
      } else {
        // A slow but valid native final must not trigger a success-as-cancellation fallback.
        await vi.advanceTimersByTimeAsync(30_000);
        expect(settled).toBe(false);
        expect(harness.requests.filter(({ method }) => method === "turn/interrupt")).toEqual([]);
        await harness.notify(
          turnCompleted({
            id: "turn-1",
            status: "completed",
            items: [
              { id: "coda", type: "agentMessage", phase: "final_answer", text: "Redundant answer" },
            ],
          }),
        );
        const result = await run;
        expect(readAttemptTerminal(result)).toMatchObject({ aborted: false, timedOut: false });
        expect(result.sourceReplyDelivered).toBe(true);
        expect(result.assistantTexts).toEqual([]);
        expect(harness.requests.filter(({ method }) => method === "turn/interrupt")).toEqual([]);
      }
    } finally {
      harness.close();
      await run;
      vi.useRealTimers();
    }
  },
);

it.each(["reply-first", "yield-first"] as const)(
  "keeps explicit yield immediate beside a final reply (%s)",
  async (order) => {
    await using h = createTerminalReleaseHarness();
    await h.observeResponse(["reply", "call-yield"]);
    const reply = dynamicToolResult("reply", {
      success: true,
      terminate: true,
      finalSourceReplyDelivered: true,
    });
    const results =
      order === "reply-first"
        ? [reply, terminalYieldResult(true)]
        : [terminalYieldResult(true), reply];
    for (const result of results) {
      h.controller.recordDynamicToolResult(result);
    }
    await yieldImmediate();
    expect(h.state.completed).toBe(true);
    expect(h.request.mock.calls.filter(([method]) => method === "turn/interrupt")).toHaveLength(1);
  },
);

it.each(["reply", "sibling"] as const)(
  "keeps a later yield independent of the retired final batch (%s first)",
  async (first) => {
    await using h = createTerminalReleaseHarness();
    await h.observeResponse(["reply", "sibling"]);
    h.pendingOpenClawDynamicToolCompletionIds.add("reply");
    h.pendingOpenClawDynamicToolCompletionIds.add("sibling");
    const results = {
      reply: dynamicToolResult("reply", {
        success: false,
        terminate: true,
        finalSourceReplyDelivered: true,
      }),
      sibling: dynamicToolResult("sibling", { success: false }),
    };
    for (const name of [first, first === "reply" ? "sibling" : "reply"] as const) {
      h.pendingOpenClawDynamicToolCompletionIds.delete(name);
      h.controller.recordDynamicToolResult(results[name]);
      h.controller.scheduleTerminalDynamicToolReleaseCheck();
      await yieldImmediate();
      expect(h.state.completed).toBe(false);
    }
    expect(h.state.pendingTerminalDynamicToolRelease).toBeUndefined();
    expect(h.state.completed).toBe(false);
    expect(h.request).not.toHaveBeenCalled();

    expect(h.resolveCompletion).not.toHaveBeenCalled();
    expect(h.sourceReplies).toEqual([]);

    // A new raw call precedes dispatch. Its registered pending execution can
    // still be running when the model response closes and release checks run.
    await h.notifyRawCall("call-yield", "sessions_yield");
    h.pendingOpenClawDynamicToolCompletionIds.add("call-yield");
    await h.finishResponse();
    await yieldImmediate();
    expect(h.state.completed).toBe(false);
    expect(h.request).not.toHaveBeenCalled();

    h.pendingOpenClawDynamicToolCompletionIds.delete("call-yield");
    h.controller.recordDynamicToolResult(terminalYieldResult(true));
    await yieldImmediate();
    expect(h.state.completed).toBe(true);
    expect(h.resolveCompletion).toHaveBeenCalledOnce();
    expect(h.request).toHaveBeenCalledWith(
      "turn/interrupt",
      { threadId: "thread-1", turnId: "turn-1" },
      expect.anything(),
    );
    expect(h.request.mock.calls.filter(([method]) => method === "turn/interrupt")).toHaveLength(1);
  },
);

it.each([
  { nested: false, deliveredFinal: true },
  { nested: true, deliveredFinal: true },
  { nested: false, deliveredFinal: false },
  { nested: true, deliveredFinal: false },
])(
  "retains yield authority across a failed sibling only with final delivery (nested: $nested, final: $deliveredFinal)",
  async ({ nested, deliveredFinal }) => {
    await using h = createTerminalReleaseHarness();
    if (nested) {
      await h.notifyRawItem({
        type: "function_call",
        call_id: "code-mode",
        name: "exec",
        namespace: "functions",
      });
      await h.finishResponse();
    } else {
      await h.observeResponse(["call-yield", "failure", ...(deliveredFinal ? ["reply"] : [])]);
    }
    const results = [
      terminalYieldResult(true),
      dynamicToolResult("failure", { success: false }),
      ...(deliveredFinal
        ? [
            dynamicToolResult("reply", {
              success: true,
              terminate: true,
              finalSourceReplyDelivered: true,
            }),
          ]
        : []),
    ];
    for (const result of results) {
      h.pendingOpenClawDynamicToolCompletionIds.add(result.call.callId);
    }
    for (const result of results) {
      h.controller.recordDynamicToolResult(result);
      h.pendingOpenClawDynamicToolCompletionIds.delete(result.call.callId);
      h.controller.scheduleTerminalDynamicToolReleaseCheck();
      await yieldImmediate();
    }
    expect(h.state.completed).toBe(deliveredFinal);
    expect(h.request.mock.calls.filter(([method]) => method === "turn/interrupt")).toHaveLength(
      deliveredFinal ? 1 : 0,
    );
    expect(h.resolveCompletion).toHaveBeenCalledTimes(deliveredFinal ? 1 : 0);
  },
);
