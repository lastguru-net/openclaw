import { describe, expect, it, onTestFinished, vi } from "vitest";
import type { NativeChildToolExecutor } from "./native-subagent-monitor-types.js";
import {
  CodexNativeSubagentMonitor,
  createClient,
  createRuntime,
  notifyChildStarted,
  itemNotification,
  agentMessage,
  collabItem,
} from "./native-subagent-monitor.test-support.js";
import type { JsonObject } from "./protocol.js";

function fixture() {
  vi.useFakeTimers();
  const client = createClient();
  const monitor = new CodexNativeSubagentMonitor(client.client, createRuntime());
  const createExecutor = (assertCurrent: () => void) =>
    ({
      observeContextCompaction: vi.fn<NativeChildToolExecutor["observeContextCompaction"]>(),
      observeToolOutcome: vi.fn<NativeChildToolExecutor["observeToolOutcome"]>(),
      handleToolCall: vi.fn<NativeChildToolExecutor["handleToolCall"]>(async () => {
        assertCurrent();
        return { success: true, contentItems: [{ type: "inputText", text: "child result" }] };
      }),
      dispose: vi.fn<NativeChildToolExecutor["dispose"]>(),
    }) satisfies NativeChildToolExecutor;
  const executors: Array<{
    executor: ReturnType<typeof createExecutor>;
    assertCurrent: () => void;
  }> = [];
  const createChildTools = vi.fn(({ assertCurrent }: { assertCurrent: () => void }) => {
    const executor = createExecutor(assertCurrent);
    executors.push({ executor, assertCurrent });
    return executor;
  });
  onTestFinished(async () => {
    await monitor.dispose();
    client.close();
    vi.useRealTimers();
  });
  const request = (threadId = "child-thread", turnId = "child-turn", signal?: AbortSignal) =>
    client.handleServerRequest(
      {
        id: "request-1",
        method: "item/tool/call",
        params: { threadId, turnId, callId: "call-1", tool: "memory_read", arguments: {} },
      },
      signal,
    );
  const start = async () => {
    const parent = await monitor.registerParent({
      parentThreadId: "parent-thread",
      createChildTools,
      modelSource: undefined,
    });
    parent.bindTurn("parent-turn");
    await client.spawn();
    await client.startTurn("child-turn");
    return parent;
  };
  return { client, monitor, executors, createChildTools, request, start };
}

describe("native child dynamic tool request ownership", () => {
  it("routes admitted child calls after successful foreground completion without hook claims", async () => {
    const f = fixture();
    const parent = await f.start();
    expect(f.createChildTools).toHaveBeenCalledOnce();
    parent.authorizeChildToolsAfterSuccessfulCompletion();
    await parent.unregister();
    await expect(f.request()).resolves.toMatchObject({ success: true });
    expect(f.executors[0]!.executor.dispose).not.toHaveBeenCalled();
    await expect(f.request("parent-thread", "parent-turn")).resolves.toBeUndefined();
    await expect(f.request("unrelated-thread")).resolves.toBeUndefined();
    await expect(f.request("child-thread", "wrong-turn")).resolves.toMatchObject({
      success: false,
    });
    expect(f.executors[0]!.executor.handleToolCall).toHaveBeenCalledOnce();
  });

  it.each<JsonObject>([
    { type: "webSearch", id: "native-web", query: "query", status: "completed" },
    {
      type: "mcpToolCall",
      id: "native-mcp",
      server: "test",
      tool: "lookup",
      status: "completed",
      result: { content: [{ type: "text", text: "untrusted result" }] },
    },
    {
      type: "mcpToolCall",
      id: "native-mcp-error",
      server: "test",
      tool: "lookup",
      status: "failed",
      result: { content: [{ type: "text", text: "remote error content" }] },
    },
  ])("observes native $id network content on the exact retained child", async (item) => {
    const f = fixture();
    const parent = await f.start();
    parent.authorizeChildToolsAfterSuccessfulCompletion();
    await parent.unregister();
    const observe = f.executors[0]!.executor.observeToolOutcome;
    await f.client.item(item, "foreign-turn", "child-thread");
    await f.client.item(item, "parent-turn", "parent-thread");
    expect(observe).not.toHaveBeenCalled();
    await f.client.item(item, "child-turn", "child-thread");
    await f.client.item(item, "child-turn", "child-thread");
    expect(observe).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ resultContentSource: "network" }),
    );
  });

  it("invalidates computer context only for the exact active child turn after foreground completion", async () => {
    const f = fixture();
    const parent = await f.start();
    parent.authorizeChildToolsAfterSuccessfulCompletion();
    await parent.unregister();
    const observe = f.executors[0]!.executor.observeContextCompaction;
    const item = { type: "contextCompaction", id: "compact-1" };
    await f.client.item(item, "foreign-turn", "child-thread");
    await f.client.item(item, "parent-turn", "parent-thread");
    expect(observe).not.toHaveBeenCalled();
    await f.client.item(item, "child-turn", "child-thread");
    expect(observe).toHaveBeenCalledExactlyOnceWith("compact-1");
    expect(f.executors[0]!.executor.observeToolOutcome).not.toHaveBeenCalled();
  });

  it("does not taint child authority for native pre-execution MCP rejection without returned content", async () => {
    const f = fixture();
    const parent = await f.start();
    await f.client.item(
      {
        type: "mcpToolCall",
        id: "rejected",
        server: "test",
        tool: "lookup",
        status: "failed",
        result: null,
        error: { message: "approval denied" },
      },
      "child-turn",
      "child-thread",
    );
    expect(f.executors[0]!.executor.observeToolOutcome).not.toHaveBeenCalled();
    await parent.unregister();
  });

  it("replays native network provenance observed before direct executable admission", async () => {
    const f = fixture();
    const parent = await f.monitor.registerParent({
      parentThreadId: "parent-thread",
      createChildTools: f.createChildTools,
    });
    parent.bindTurn("parent-turn");
    await notifyChildStarted(f.client);
    await f.client.startTurn("child-turn");
    await f.client.item(
      { type: "webSearch", id: "early-search", query: "query" },
      "child-turn",
      "child-thread",
    );
    expect(f.createChildTools).not.toHaveBeenCalled();
    await f.client.spawn();
    expect(f.executors[0]!.executor.observeToolOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ resultContentSource: "network" }),
    );
    await parent.unregister();
  });

  it("holds an early child request until authenticated parent spawn evidence arrives", async () => {
    const f = fixture();
    const parent = await f.monitor.registerParent({
      parentThreadId: "parent-thread",
      createChildTools: f.createChildTools,
    });
    parent.bindTurn("parent-turn");
    await notifyChildStarted(f.client);
    await f.client.startTurn("child-turn");
    const response = f.request();
    expect(f.createChildTools).not.toHaveBeenCalled();
    await f.client.spawn();
    await expect(response).resolves.toMatchObject({ success: true });
    expect(f.createChildTools).toHaveBeenCalledOnce();
    expect(f.executors[0]!.executor.handleToolCall).toHaveBeenCalledOnce();
    await parent.unregister();
  });

  it("cancels an early child request without dispatching after later spawn admission", async () => {
    const f = fixture();
    const parent = await f.monitor.registerParent({
      parentThreadId: "parent-thread",
      createChildTools: f.createChildTools,
    });
    parent.bindTurn("parent-turn");
    await notifyChildStarted(f.client);
    await f.client.startTurn("child-turn");
    const controller = new AbortController();
    const response = f.request("child-thread", "child-turn", controller.signal);
    controller.abort(new Error("request cancelled"));
    await expect(response).resolves.toMatchObject({ success: false });
    await f.client.spawn();
    expect(f.executors[0]!.executor.handleToolCall).not.toHaveBeenCalled();
    await parent.unregister();
  });

  it("settles early admission without a grant when the foreground registration closes", async () => {
    const f = fixture();
    const parent = await f.monitor.registerParent({
      parentThreadId: "parent-thread",
      createChildTools: f.createChildTools,
    });
    parent.bindTurn("parent-turn");
    await notifyChildStarted(f.client);
    await f.client.startTurn("child-turn");
    const response = f.request();
    await parent.unregister();
    await expect(response).resolves.toMatchObject({ success: false });
    expect(f.createChildTools).not.toHaveBeenCalled();
  });

  it("does not replace a live executor on duplicate spawn evidence", async () => {
    const f = fixture();
    const parent = await f.start();
    await f.client.spawn();
    expect(f.createChildTools).toHaveBeenCalledOnce();
    expect(f.executors[0]!.executor.dispose).not.toHaveBeenCalled();
    await expect(f.request()).resolves.toMatchObject({ success: true });
    await parent.unregister();
  });

  it("captures an accepted queued turn before foreground cleanup and transfers its executor", async () => {
    const f = fixture();
    const parent = await f.start();
    await f.client.startTurn("queued-turn");
    await f.client.notify(
      itemNotification({
        type: "subAgentActivity",
        id: "accept-queued",
        kind: "interacted",
        agentThreadId: "child-thread",
        agentPath: "/root/child",
      }),
    );
    expect(f.createChildTools).toHaveBeenCalledTimes(2);
    parent.authorizeChildToolsAfterSuccessfulCompletion();
    await parent.unregister();
    await f.client.finishTurn("child-turn", agentMessage("first-result", "First task finished"));
    await expect(f.request("child-thread", "queued-turn")).resolves.toMatchObject({
      success: true,
    });
    expect(f.createChildTools).toHaveBeenCalledTimes(2);
    expect(f.executors[1]!.executor.handleToolCall).toHaveBeenCalledOnce();
  });

  it.each<JsonObject>([
    { type: "webSearch", id: "prior-web", query: "query", status: "completed" },
    {
      type: "mcpToolCall",
      id: "prior-mcp",
      server: "test",
      tool: "lookup",
      status: "completed",
      result: { content: [{ type: "text", text: "untrusted result" }] },
    },
  ])(
    "preserves a tainted $type grant across input before foreground turn binding",
    async (item) => {
      const f = fixture();
      const first = await f.start();
      await f.client.item(item, "child-turn", "child-thread");
      expect(f.executors[0]!.executor.observeToolOutcome).toHaveBeenCalledWith(
        expect.objectContaining({ resultContentSource: "network" }),
      );
      first.authorizeChildToolsAfterSuccessfulCompletion();
      await first.unregister();
      const next = await f.monitor.registerParent({
        parentThreadId: "parent-thread",
        createChildTools: f.createChildTools,
        modelSource: undefined,
      });
      await f.client.notify(
        itemNotification(
          {
            type: "subAgentActivity",
            id: "prebind-input",
            kind: "interacted",
            agentThreadId: "child-thread",
            agentPath: "/root/child",
          },
          "next-parent-turn",
        ),
      );
      expect(f.createChildTools).toHaveBeenCalledOnce();
      next.bindTurn("next-parent-turn");
      expect(f.createChildTools).toHaveBeenCalledTimes(2);
      expect(f.executors[0]!.executor.dispose).not.toHaveBeenCalled();
      await expect(f.request()).resolves.toMatchObject({ success: true });
      next.authorizeChildToolsAfterSuccessfulCompletion();
      await next.unregister();
      expect(f.executors[0]!.executor.dispose).not.toHaveBeenCalled();
      await expect(f.request()).resolves.toMatchObject({ success: true });
      await f.client.finishTurn("child-turn", agentMessage("first-result", "First task finished"));
      await f.client.startTurn("receiver-turn");
      await expect(f.request("child-thread", "receiver-turn")).resolves.toMatchObject({
        success: true,
      });
      expect(f.createChildTools).toHaveBeenCalledTimes(2);
    },
  );

  it("captures the real accepted submission before any receiver turn and executes after parent closure", async () => {
    const f = fixture();
    const parent = await f.start();
    await f.client.item(collabItem("sendInput", ["child-thread"], { id: "send-next" }));
    await f.client.sendInputOutput({ callId: "send-next", submissionId: "actual-submission" });
    expect(f.createChildTools).toHaveBeenCalledTimes(2);
    expect(f.createChildTools.mock.calls[1]![0]).toMatchObject({
      runId: "codex-native-tool-input:child-thread:submission:parent-turn:actual-submission",
    });
    // Accepting queued input must not revoke the exact currently running turn.
    await expect(f.request()).resolves.toMatchObject({ success: true });
    await f.client.sendInputOutput({ callId: "send-next", submissionId: "actual-submission" });
    expect(f.createChildTools).toHaveBeenCalledTimes(2);
    parent.authorizeChildToolsAfterSuccessfulCompletion();
    await parent.unregister();
    await f.client.finishTurn("child-turn", agentMessage("first-result", "First task finished"));
    await f.client.startTurn("receiver-turn");
    await expect(f.request("child-thread", "receiver-turn")).resolves.toMatchObject({
      success: true,
    });
    expect(f.createChildTools).toHaveBeenCalledTimes(2);
    expect(f.executors[1]!.executor.handleToolCall).toHaveBeenCalledOnce();
  });

  it("revokes an accepted unbound submission grant on failed foreground completion", async () => {
    const f = fixture();
    const parent = await f.start();
    await f.client.item(collabItem("sendInput", ["child-thread"], { id: "send-next" }));
    await f.client.sendInputOutput({ callId: "send-next", submissionId: "actual-submission" });
    expect(f.createChildTools).toHaveBeenCalledTimes(2);
    await parent.unregister();
    expect(f.executors[1]!.executor.dispose).toHaveBeenCalledOnce();
    expect(f.executors[1]!.assertCurrent).toThrow("no longer current");
    await f.client.finishTurn("child-turn", agentMessage("first-result", "First task finished"));
    await f.client.startTurn("receiver-turn");
    await expect(f.request("child-thread", "receiver-turn")).resolves.toMatchObject({
      success: false,
    });
    expect(f.createChildTools).toHaveBeenCalledTimes(2);
  });

  it("revokes a captured queued executor when foreground completion failed", async () => {
    const f = fixture();
    const parent = await f.start();
    await f.client.startTurn("queued-turn");
    await f.client.notify(
      itemNotification({
        type: "subAgentActivity",
        id: "accept-queued",
        kind: "interacted",
        agentThreadId: "child-thread",
        agentPath: "/root/child",
      }),
    );
    expect(f.createChildTools).toHaveBeenCalledTimes(2);
    await parent.unregister();
    expect(f.executors[1]!.executor.dispose).toHaveBeenCalledOnce();
    expect(f.executors[1]!.assertCurrent).toThrow("no longer current");
  });

  it("revokes child tools when foreground cleanup was not authorized for retention", async () => {
    const f = fixture();
    const parent = await f.start();
    await parent.unregister();
    expect(f.executors[0]!.executor.dispose).toHaveBeenCalledOnce();
    expect(f.executors[0]!.assertCurrent).toThrow("no longer current");
    await expect(f.request()).resolves.toMatchObject({ success: false });
  });

  it("does not issue tools from observation or nested child lineage", async () => {
    const f = fixture();
    const parent = await f.start();
    await notifyChildStarted(f.client, "parent-thread", "observed-only");
    await expect(f.request("observed-only")).resolves.toMatchObject({ success: false });
    await notifyChildStarted(f.client, "child-thread", "grandchild", "/root/child/grandchild");
    await f.client.spawn("grandchild", "child-turn", "v1", "child-thread");
    await expect(f.request("grandchild")).resolves.toMatchObject({ success: false });
    expect(f.createChildTools).toHaveBeenCalledOnce();
    await parent.unregister();
  });

  it("revokes tools synchronously at parent retirement and removes its handler at disposal", async () => {
    const f = fixture();
    const parent = await f.start();
    parent.authorizeChildToolsAfterSuccessfulCompletion();
    await parent.unregister();
    const retirement = f.monitor.retireParent("parent-thread");
    expect(f.executors[0]!.executor.dispose).toHaveBeenCalledOnce();
    expect(f.executors[0]!.assertCurrent).toThrow("no longer current");
    await retirement;
    await f.monitor.dispose();
    await expect(f.request()).resolves.toBeUndefined();
  });

  it("releases turn-scoped tools on interruption", async () => {
    const f = fixture();
    const parent = await f.start();
    await f.client.completeTurn({ turnId: "child-turn", status: "interrupted" });
    expect(f.executors[0]!.executor.dispose).toHaveBeenCalledOnce();
    await expect(f.request()).resolves.toMatchObject({ success: false });
    await parent.unregister();
  });
});
