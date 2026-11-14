import { AsyncLocalStorage, AsyncResource } from "node:async_hooks";
import { setImmediate } from "node:timers/promises";
import { runWithAsyncWorkResources } from "openclaw/plugin-sdk/agent-harness-tool-runtime";
import { AsyncWorkScope, getAsyncWorkSignal } from "openclaw/plugin-sdk/concurrency-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import type { CodexPluginConfig } from "./config.js";
import {
  createBridge,
  createDynamicToolCall,
  createTool,
  textToolResult,
} from "./dynamic-tools.test-support.js";
import {
  createCodexTestHostCapabilities,
  setCodexTestToolFactory,
} from "./host-capability.test-support.js";
import { prepareCodexNativeChildToolFactory } from "./native-child-tools.js";
import type { NativeChildToolExecutor } from "./native-subagent-monitor-types.js";

function fixture(
  policy: CodexPluginConfig["nativeChildTools"] = { allow: ["*"] },
  hostAvailable = true,
) {
  let parentActive = true;
  let sourceActive = true;
  let childSignal: AbortSignal | undefined;
  const effects = vi.fn(async () => textToolResult("fresh child result"));
  const staleEffect = vi.fn(async () => {
    throw new Error("dead parent executor used");
  });
  const parentTools = ["read_note", "research__get_item", "message"].map((name) =>
    createTool(name, {
      execute: staleEffect,
      parameters: {
        type: "object",
        properties: { note: { type: "string" } },
        additionalProperties: false,
      },
    }),
  );
  const release = vi.fn();
  const close = vi.fn(async () => {});
  const assertSource = () => {
    if (!sourceActive) {
      throw new Error("source revoked");
    }
    childSignal?.throwIfAborted();
  };
  const childBase = createCodexTestHostCapabilities({ assertActive: assertSource });
  const childHost = {
    ...childBase,
    computerContextEpoch: { value: 0 },
    observeToolOutcome: vi.fn(),
    createToolSurfaceAsync: () => childBase.createToolSurfaceAsync!({}),
  };
  setCodexTestToolFactory({ hostCapabilities: childBase }, () => [
    createTool("read_note", { execute: effects, parameters: parentTools[0]!.parameters }),
  ]);
  const createHost = vi.fn(async ({ signal }: { runId: string; signal?: AbortSignal }) => {
    if (!parentActive) {
      throw new Error("foreground closed");
    }
    childSignal = signal;
    return { capabilities: childHost, close };
  });
  const parentHost = createCodexTestHostCapabilities({
    assertActive: () => {
      if (!parentActive) {
        throw new Error("foreground closed");
      }
    },
    createDelegatedToolHost: hostAvailable ? createHost : undefined,
  });
  const mcpDispose = vi.fn(async () => {});
  const materializeMcpTools = vi.fn(async () => ({
    tools: [
      createTool("research__get_item", {
        execute: effects,
        parameters: parentTools[1]!.parameters,
      }),
    ],
    dispose: mcpDispose,
  }));
  const factory = prepareCodexNativeChildToolFactory({
    policy,
    hostCapabilities: parentHost,
    parentBridge: createBridge(parentTools),
    registeredTools: parentTools,
    executionPolicy: {
      policy: {
        nativeToolSurfaceAllowed: true,
        sandboxed: false,
        requestedExecHost: "auto",
        effectiveExecHost: "gateway",
      },
      assertCurrent: async () => assertSource(),
      admit: async (write) => write(),
      retain: () => release,
      release: () => {},
    },
    cwd: "/workspace",
    hookContext: { sessionId: "session", sessionKey: "agent:main:test", agentId: "main" },
    normalizeTools: (tools) => tools,
    materializeMcpTools,
  });
  const executors: NativeChildToolExecutor[] = [];
  const start = () => {
    const executor = factory.createChildTools!({
      runId: "child-run",
      threadId: "thread-1",
      assertCurrent: assertSource,
    });
    executors.push(executor);
    return executor;
  };
  onTestFinished(async () => {
    executors.forEach((executor) => executor.dispose());
    if (executors.length) {
      await vi.waitFor(() => expect(release).toHaveBeenCalled());
    }
  });
  const call = (
    executor: NativeChildToolExecutor,
    name = "read_note",
    id = "call-1",
    signal = new AbortController().signal,
  ) => executor.handleToolCall(createDynamicToolCall(name, {}, id), signal);
  return {
    factory,
    start,
    call,
    effects,
    staleEffect,
    createHost,
    childHost,
    materializeMcpTools,
    mcpDispose,
    close,
    release,
    closeParent: () => {
      parentActive = false;
    },
    revoke: () => {
      sourceActive = false;
    },
  };
}

describe("native child host tool executor", () => {
  it("leaves empty grants inert and rejects configured delegation without a host issuer", () => {
    for (const f of [fixture({ allow: [] }), fixture({ allow: [] }, false)]) {
      expect(f.factory.createChildTools).toBeUndefined();
      expect(f.factory.catalog.tools.some((tool) => tool.status === "allowed")).toBe(false);
      expect(f.createHost).not.toHaveBeenCalled();
      expect(f.materializeMcpTools).not.toHaveBeenCalled();
    }
    expect(() => fixture({ allow: ["*"] }, false)).toThrow("delegated tool issuer");
  });

  it("rejects malformed arguments at the real bridge before plugin effects", async () => {
    const f = fixture();
    const child = f.start();
    expect(
      await child.handleToolCall(
        createDynamicToolCall("read_note", { note: 42 }),
        new AbortController().signal,
      ),
    ).toMatchObject({ success: false });
    expect(f.effects).not.toHaveBeenCalled();
    expect(await f.call(child, "read_note", "valid")).toMatchObject({ success: true });
    expect(f.effects).toHaveBeenCalledOnce();
  });

  it("cancels pending preparation without dispatching and closes acquired resources", async () => {
    const f = fixture();
    const gate = createDeferred<void>();
    f.materializeMcpTools.mockImplementationOnce(async () => {
      await gate.promise;
      return { tools: [], dispose: f.mcpDispose };
    });
    const child = f.start();
    const result = f.call(child);
    await vi.waitFor(() => expect(f.materializeMcpTools).toHaveBeenCalledOnce());
    child.dispose();
    gate.resolve();
    expect(await result).toMatchObject({ success: false });
    await vi.waitFor(() => expect(f.close).toHaveBeenCalledOnce());
    expect(f.mcpDispose).toHaveBeenCalledOnce();
    expect(f.effects).not.toHaveBeenCalled();
  });

  it("reconstructs plugin and MCP executors and survives foreground completion", async () => {
    const f = fixture();
    const child = f.start();
    f.closeParent();
    await expect(f.call(child)).resolves.toMatchObject({ success: true });
    await expect(f.call(child, "research__get_item", "mcp-call")).resolves.toMatchObject({
      success: true,
    });
    expect(f.materializeMcpTools).toHaveBeenCalledWith({
      hostCapabilities: f.childHost,
      runId: "child-run",
    });
    expect(f.staleEffect).not.toHaveBeenCalled();
    expect(f.effects).toHaveBeenCalledTimes(2);
    expect(f.start).toThrow("foreground closed");
  });

  it("owns preparation and calls dispatched from a completed foreground async context", async () => {
    const f = fixture();
    const foreground = new AsyncWorkScope();
    const authority = new AsyncLocalStorage<string>();
    let issuanceSignal: AbortSignal | undefined;
    let preparationSignal: AbortSignal | undefined;
    const createHost = f.createHost.getMockImplementation()!;
    f.createHost.mockImplementation((request) => {
      issuanceSignal = getAsyncWorkSignal();
      expect(authority.getStore()).toBe("original-source");
      return createHost(request);
    });
    const materialize = f.materializeMcpTools.getMockImplementation()!;
    f.materializeMcpTools.mockImplementation(async () => {
      preparationSignal = getAsyncWorkSignal();
      expect(authority.getStore()).toBe("original-source");
      return materialize();
    });
    f.effects.mockImplementation(async () => {
      expect(authority.getStore()).toBe("original-source");
      expect(getAsyncWorkSignal()?.aborted).toBe(false);
      return textToolResult("independently owned");
    });
    const invoke = await authority.run("original-source", () =>
      foreground.track(async () => {
        const child = f.start();
        return AsyncResource.bind(() => f.call(child));
      }),
    );
    await foreground.drain();
    f.closeParent();
    expect(issuanceSignal).toBeDefined();
    expect(issuanceSignal).not.toBe(foreground.signal);
    expect(issuanceSignal?.aborted).toBe(false);
    expect(await invoke()).toMatchObject({ success: true });
    expect(preparationSignal).toBe(issuanceSignal);
    expect(f.effects).toHaveBeenCalledOnce();
  });

  it("retains resources until a started implementation settles after cancellation", async () => {
    const f = fixture();
    const finish = createDeferred<void>();
    f.effects.mockImplementation(async () => {
      await finish.promise;
      return textToolResult("late implementation result");
    });
    const child = f.start();
    const response = f.call(child);
    try {
      await vi.waitFor(() => expect(f.effects).toHaveBeenCalledOnce());
      child.dispose();
      expect(await response).toMatchObject({ success: false });
      await setImmediate();
      expect(f.mcpDispose).not.toHaveBeenCalled();
      expect(f.close).not.toHaveBeenCalled();
      expect(f.release).not.toHaveBeenCalled();
    } finally {
      finish.resolve();
    }
    await vi.waitFor(() => expect(f.close).toHaveBeenCalledOnce());
    expect(f.mcpDispose).toHaveBeenCalledOnce();
    expect(f.release).toHaveBeenCalledOnce();
  });

  it("retains resources through cooperating cleanup after the logical tool result", async () => {
    const f = fixture();
    const cleanupStarted = createDeferred<void>();
    const finishCleanup = createDeferred<void>();
    f.effects.mockImplementation(async () =>
      runWithAsyncWorkResources(async (onAcquired) => {
        onAcquired({
          release: async () => {
            cleanupStarted.resolve();
            await finishCleanup.promise;
          },
        });
        return textToolResult("accepted result");
      }),
    );
    const child = f.start();
    try {
      expect(await f.call(child)).toMatchObject({ success: true });
      await cleanupStarted.promise;
      child.dispose();
      await setImmediate();
      expect(f.mcpDispose).not.toHaveBeenCalled();
      expect(f.close).not.toHaveBeenCalled();
      expect(f.release).not.toHaveBeenCalled();
    } finally {
      finishCleanup.resolve();
      child.dispose();
    }
    await vi.waitFor(() => expect(f.close).toHaveBeenCalledOnce());
    expect(f.mcpDispose).toHaveBeenCalledOnce();
    expect(f.release).toHaveBeenCalledOnce();
  });

  it.each([false, true])(
    "owns cleanup tails after the foreground drains (MCP failure: %s)",
    async (failMcp) => {
      const f = fixture();
      const foreground = new AsyncWorkScope();
      const mcpCleanupStarted = createDeferred<void>();
      const finishMcpCleanup = createDeferred<void>();
      const hostCleanupStarted = createDeferred<void>();
      const finishHostCleanup = createDeferred<void>();
      f.mcpDispose.mockImplementation(async () => {
        expect(getAsyncWorkSignal()).toBeDefined();
        expect(getAsyncWorkSignal()).not.toBe(foreground.signal);
        await runWithAsyncWorkResources(async (onAcquired) => {
          onAcquired({
            release: async () => {
              mcpCleanupStarted.resolve();
              await finishMcpCleanup.promise;
            },
          });
          if (failMcp) {
            throw new Error("MCP cleanup failed after starting its release tail");
          }
        });
      });
      f.close.mockImplementation(async () => {
        expect(getAsyncWorkSignal()).not.toBe(foreground.signal);
        await runWithAsyncWorkResources(async (onAcquired) => {
          onAcquired({
            release: async () => {
              hostCleanupStarted.resolve();
              await finishHostCleanup.promise;
            },
          });
        });
      });
      const dispose = await foreground.track(async () => {
        const child = f.start();
        expect(await f.call(child)).toMatchObject({ success: true });
        return AsyncResource.bind(() => child.dispose());
      });
      await foreground.drain();
      f.closeParent();
      try {
        dispose();
        await mcpCleanupStarted.promise;
        expect(f.close).not.toHaveBeenCalled();
        expect(f.release).not.toHaveBeenCalled();
        finishMcpCleanup.resolve();
        await hostCleanupStarted.promise;
        expect(f.release).not.toHaveBeenCalled();
      } finally {
        finishMcpCleanup.resolve();
        finishHostCleanup.resolve();
        dispose();
      }
      await vi.waitFor(() => expect(f.release).toHaveBeenCalledOnce());
      expect(f.mcpDispose).toHaveBeenCalledOnce();
      expect(f.close).toHaveBeenCalledOnce();
    },
  );

  it("rejects source controls and unknown tools without executing callbacks", async () => {
    const f = fixture();
    const child = f.start();
    expect(await f.call(child, "message")).toMatchObject({
      success: false,
      contentItems: [{ text: expect.stringContaining("unsupported") }],
    });
    expect(await f.call(child, "unknown")).toMatchObject({ success: false });
    expect(f.effects).not.toHaveBeenCalled();
  });

  it("shares in-flight/completed exact replays and refuses changed arguments", async () => {
    const f = fixture();
    const gate = createDeferred<void>();
    f.effects.mockImplementation(async () => {
      await gate.promise;
      return textToolResult("once");
    });
    const child = f.start();
    const first = f.call(child);
    const duplicate = f.call(child);
    await vi.waitFor(() => expect(f.effects).toHaveBeenCalledOnce());
    expect(
      await child.handleToolCall(
        createDynamicToolCall("read_note", { changed: true }),
        new AbortController().signal,
      ),
    ).toMatchObject({
      success: false,
      contentItems: [{ text: expect.stringContaining("conflicting replay") }],
    });
    gate.resolve();
    expect(await first).toEqual(await duplicate);
    expect(await f.call(child)).toEqual(await first);
    expect(f.effects).toHaveBeenCalledOnce();
  });

  it("revokes even cached replies and disposes both independent owners once", async () => {
    const f = fixture();
    const child = f.start();
    expect(await f.call(child)).toMatchObject({ success: true });
    f.revoke();
    expect(await f.call(child)).toMatchObject({ success: false });
    expect(await f.call(child, "read_note", "new-call")).toMatchObject({ success: false });
    expect(f.effects).toHaveBeenCalledOnce();
    child.dispose();
    child.dispose();
    await vi.waitFor(() => expect(f.close).toHaveBeenCalledOnce());
    expect(f.mcpDispose).toHaveBeenCalledOnce();
    expect(f.release).toHaveBeenCalledOnce();
  });
});
