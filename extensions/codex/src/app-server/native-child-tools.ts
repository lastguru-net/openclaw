import { isDeepStrictEqual } from "node:util";
import {
  embeddedAgentLog,
  getChannelAgentToolMeta,
  getPluginToolMeta,
  type AnyAgentTool,
  type EmbeddedRunAttemptParamsV2,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  createAgentHarnessToolExecutionRegistry,
  runWithAsyncWorkResources,
} from "openclaw/plugin-sdk/agent-harness-tool-runtime";
import { AsyncWorkScope } from "openclaw/plugin-sdk/concurrency-runtime";
import {
  invalidateCodexComputerFrame,
  type CodexComputerContextEpoch,
} from "./computer-context.js";
import type { CodexPluginConfig } from "./config.js";
import {
  handleDynamicToolCallWithTimeout,
  resolveDynamicToolCallTimeoutMs,
  toCodexDynamicToolProtocolResponse,
} from "./dynamic-tool-execution.js";
import { createFailedDynamicToolResponse } from "./dynamic-tool-response-state.js";
import { createCodexDynamicToolBridge, type CodexDynamicToolBridge } from "./dynamic-tools.js";
import { inspectCodexNativeChildTools } from "./native-child-tool-policy.js";
import type { PreparedCodexNativeExecutionPolicy } from "./native-execution-policy.js";
import type {
  ParentOwner,
  NativeChildToolExecutor,
  NativeChildToolOutcome,
} from "./native-subagent-monitor-types.js";
import type { CodexDynamicToolCallParams, CodexDynamicToolCallResponse } from "./protocol.js";

type Host = EmbeddedRunAttemptParamsV2["hostCapabilities"];
type HookContext = NonNullable<Parameters<typeof createCodexDynamicToolBridge>[0]["hookContext"]>;
type MaterializedTools = { tools: AnyAgentTool[]; dispose: () => Promise<void> };

/** Metadata, not naming conventions, identifies channel-owned reply tools. */
export function describeCodexNativeChildTool(tool: AnyAgentTool) {
  const meta = getPluginToolMeta(tool);
  return {
    name: tool.name,
    ...(meta?.pluginId ? { pluginId: meta.pluginId } : {}),
    ...(meta?.mcp?.serverName ? { mcpServerName: meta.mcp.serverName } : {}),
    ...(getChannelAgentToolMeta(tool)
      ? { unsupportedReason: "Channel reply tools require a foreground reply owner." }
      : {}),
  };
}

/** Each admitted assignment constructs fresh executors; no parent callback is retained. */
export function prepareCodexNativeChildToolFactory(options: {
  policy: CodexPluginConfig["nativeChildTools"];
  hostCapabilities: Host;
  parentBridge: CodexDynamicToolBridge;
  registeredTools: readonly AnyAgentTool[];
  executionPolicy: PreparedCodexNativeExecutionPolicy;
  cwd: string;
  hookContext: Pick<
    HookContext,
    | "agentId"
    | "config"
    | "sessionId"
    | "sessionKey"
    | "channelId"
    | "contextWindowTokens"
    | "requester"
    | "turnSourceChannel"
    | "turnSourceTo"
    | "turnSourceAccountId"
    | "turnSourceThreadId"
    | "trigger"
    | "approvalReviewerDeviceId"
  >;
  normalizeTools: (tools: AnyAgentTool[]) => AnyAgentTool[];
  materializeMcpTools: (request: {
    hostCapabilities: Host;
    runId: string;
  }) => Promise<MaterializedTools>;
}) {
  // Only immutable declarations and independent construction recipes cross the
  // foreground boundary. Never retain the parent bridge or its executors.
  const policy = options.policy ? structuredClone(options.policy) : undefined;
  const { hostCapabilities, executionPolicy, cwd, normalizeTools, materializeMcpTools } = options;
  const createHost = hostCapabilities.createDelegatedToolHost;
  const catalog = inspectCodexNativeChildTools(
    policy,
    options.parentBridge.availableTools.map(describeCodexNativeChildTool),
    options.registeredTools.map(describeCodexNativeChildTool),
  );
  const allowed = new Set(
    catalog.tools.filter((tool) => tool.status === "allowed").map((tool) => tool.name),
  );
  if (!policy?.allow?.length) {
    return { catalog, createChildTools: undefined };
  }
  if (!createHost) {
    throw new Error("Configured native child tools require the host's delegated tool issuer.");
  }
  if (!allowed.size) {
    return { catalog, createChildTools: undefined };
  }
  const registeredSpecs = structuredClone(options.parentBridge.specs);
  const hookContext = { ...options.hookContext };
  const createChildTools: ParentOwner["createChildTools"] = (request) => {
    hostCapabilities.assertActive();
    request.assertCurrent();
    const controller = new AbortController();
    // Transport callbacks can retain a completed foreground work scope. Switch
    // only work ownership; the issuing caller/source context stays intact.
    const work = new AsyncWorkScope();
    const releasePolicy = executionPolicy.retain();
    // Issuance captures authority synchronously, before foreground cleanup can run.
    let hostPromise: ReturnType<NonNullable<Host["createDelegatedToolHost"]>>;
    try {
      hostPromise = work.run(() => createHost({ runId: request.runId, signal: controller.signal }));
    } catch (error) {
      releasePolicy();
      throw error;
    }
    let mcp: MaterializedTools | undefined;
    let nativeOutcome: NativeChildToolOutcome | undefined;
    let computerContextEpoch: CodexComputerContextEpoch | undefined;
    const completedCompactions = new Set<string>();
    let observeOutcome: NativeChildToolExecutor["observeToolOutcome"] | undefined;
    let closed = false;
    const assertCurrent = () => {
      controller.signal.throwIfAborted();
      request.assertCurrent();
    };
    const prepared = work.track(async () => {
      const host = (await hostPromise).capabilities;
      assertCurrent();
      computerContextEpoch = host.computerContextEpoch;
      observeOutcome = host.observeToolOutcome;
      if (nativeOutcome) {
        observeOutcome(nativeOutcome);
      }
      if (!host.createToolSurfaceAsync) {
        throw new Error("The host does not support delegated tool construction.");
      }
      const tools = await host.createToolSurfaceAsync({}, { cwd });
      assertCurrent();
      mcp = await materializeMcpTools({
        hostCapabilities: host,
        runId: request.runId,
      });
      assertCurrent();
      const fresh = normalizeTools([...tools, ...host.bindToolSurface(mcp.tools, { cwd })]).filter(
        (tool) => allowed.has(tool.name),
      );
      const bridge = createCodexDynamicToolBridge({
        tools: fresh,
        registeredSpecs,
        requireExactRegisteredDefinitions: true,
        signal: controller.signal,
        assertCurrent,
        assertCurrentAsync: executionPolicy.assertCurrent,
        computerContextEpoch,
        hookContext: {
          ...hookContext,
          runId: request.runId,
          onToolOutcome: host.observeToolOutcome,
        },
      });
      embeddedAgentLog.debug("codex native-child executable tools", {
        runId: request.runId,
        childThreadId: request.threadId,
        ...inspectCodexNativeChildTools(
          policy,
          bridge.availableTools.map(describeCodexNativeChildTool),
          catalog.tools,
        ),
      });
      return {
        ...bridge,
        // A timeout can return before the implementation settles. Its actual
        // execution and cooperating cleanup still own host/MCP resources.
        handleToolCall: (...args: Parameters<CodexDynamicToolBridge["handleToolCall"]>) =>
          runWithAsyncWorkResources(async () => bridge.handleToolCall(...args)),
      };
    });
    const dispose = () => {
      if (closed) {
        return;
      }
      closed = true;
      controller.abort(new Error("Codex native child tool owner closed."));
      work.beginClose(controller.signal.reason);
      const cleanup = (async () => {
        // Revoke immediately. Cleanup starts only after admitted work settles,
        // and keeps this owner open for its own cooperating cleanup tails.
        try {
          await work.runWhenIdle(async () => mcp?.dispose());
        } finally {
          try {
            await work.runWhenIdle(async () => (await hostPromise).close());
          } finally {
            await work.drain();
            releasePolicy();
          }
        }
      })();
      void cleanup.catch((error: unknown) =>
        embeddedAgentLog.warn("Failed to close Codex native child tools", {
          runId: request.runId,
          error: String(error),
        }),
      );
    };
    void prepared.catch(dispose);
    const registry = createAgentHarnessToolExecutionRegistry<
      CodexDynamicToolCallParams,
      CodexDynamicToolCallResponse
    >((call) => [call.threadId, call.turnId, call.callId]);
    const payloads = new Map<
      string,
      Pick<CodexDynamicToolCallParams, "namespace" | "tool" | "arguments">
    >();
    const fail = (message: string) =>
      toCodexDynamicToolProtocolResponse(createFailedDynamicToolResponse(message));
    const executor: NativeChildToolExecutor = {
      observeContextCompaction(itemId) {
        assertCurrent();
        if (completedCompactions.has(itemId)) {
          return;
        }
        completedCompactions.add(itemId);
        // Before host preparation no frame can exist. Remember the completion
        // anyway so a duplicate cannot invalidate a later screenshot.
        if (computerContextEpoch) {
          invalidateCodexComputerFrame(computerContextEpoch);
        }
      },
      observeToolOutcome(observation) {
        assertCurrent();
        // Native retrieval can finish while fresh host/MCP preparation is pending.
        nativeOutcome = observation;
        observeOutcome?.(observation);
      },
      async handleToolCall(call, signal, setExecutionTimeoutMs) {
        try {
          assertCurrent();
          signal.throwIfAborted();
          if (call.threadId !== request.threadId) {
            return fail("OpenClaw child tool thread does not match its admitted owner.");
          }
          const status = catalog.tools.find((tool) => tool.name === call.tool);
          if (!allowed.has(call.tool)) {
            return fail(
              `OpenClaw native-child tool ${call.tool} is ${status?.status ?? "unavailable"}.${status?.unsupportedReason ? ` ${status.unsupportedReason}` : " Check nativeChildTools.allow/deny and the owning session tool policy."}`,
            );
          }
          const key = JSON.stringify([call.threadId, call.turnId, call.callId]);
          const payload = {
            namespace: call.namespace,
            tool: call.tool,
            arguments: call.arguments,
          };
          const previous = payloads.get(key);
          if (previous && !isDeepStrictEqual(previous, payload)) {
            return fail("OpenClaw rejected a conflicting replay of a native child tool call.");
          }
          if (!previous) {
            payloads.set(key, structuredClone(payload));
          }
          const timeoutMs = resolveDynamicToolCallTimeoutMs({
            call,
            config: hookContext.config,
          });
          if (timeoutMs !== null) {
            setExecutionTimeoutMs?.(timeoutMs);
          }
          return await registry.claim(call, () =>
            work.track(async () => {
              const bridge = await prepared;
              assertCurrent();
              return toCodexDynamicToolProtocolResponse(
                await handleDynamicToolCallWithTimeout({
                  call,
                  toolBridge: bridge,
                  signal: AbortSignal.any([controller.signal, signal]),
                  timeoutMs,
                }),
              );
            }),
          ).execution;
        } catch (error) {
          return fail(
            `OpenClaw native-child tool execution unavailable: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      },
      dispose,
    };
    return executor;
  };
  return { catalog, createChildTools };
}
