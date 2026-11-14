import { runOutsideOperatorToolGatewayAuthority } from "../../gateway/operator-tool-gateway-authority.js";
import {
  withInstallationTarget,
  type InstallationTarget,
} from "../../infra/installation-target-context.js";
import { retainMemoryAudience } from "../../plugins/memory-audience.js";
import {
  getGatewayContextResolver,
  withPluginRuntimeGatewayContextResolver,
} from "../../plugins/runtime/gateway-request-scope.js";
import { prepareDelegatedAgentRunAdmission } from "../admitted-run-context.js";
import { wrapAgentToolExecutionContext } from "../agent-tool-metadata.js";
import { cloneAuthProfileStore } from "../auth-profiles/clone.js";
import type { EmbeddedRunAttemptInternalParams } from "../embedded-agent-runner/run/internal-params.js";
import { createAgentTurnTaintState } from "../embedded-agent-runner/run/turn-taint-state.js";
import { runOutsideAgentPluginRuntimeRefresh } from "../plugin-runtime-refresh.js";
import type { AnyAgentTool } from "../tools/common.js";
import type { getGatewayToolCallerIdentity } from "../tools/gateway-caller-context.js";
import type {
  AgentHarnessDelegatedToolHostCapabilities,
  AgentHarnessHostCapabilities,
} from "./host-capability-types.js";
import { captureDelegatedToolOptions } from "./host-delegated-tool-options.js";
import { cloneHostSnapshot as cloneSnapshot } from "./host-snapshot.js";

export type AgentHarnessHostAttempt = Partial<EmbeddedRunAttemptInternalParams> &
  Pick<EmbeddedRunAttemptInternalParams, "admittedRunContext" | "runId">;

export type AgentHarnessHostOptions = {
  attempt: AgentHarnessHostAttempt;
  pluginId: string;
  requiredNodeCommands?: readonly string[];
  nativeModelPolicySupport?: "exact";
  toolCalls?: "deny";
};
export type AgentHarnessHostOwner = {
  capabilities: AgentHarnessHostCapabilities;
  close: () => void;
  setInputAttachmentReadAllowed: (allowed: boolean) => void;
  runWithScope: <T>(run: () => Promise<T>) => Promise<T>;
  runWithCaller: <T>(run: () => Promise<T>) => Promise<T>;
};
type AgentHarnessHostFactory = (params: AgentHarnessHostOptions) => AgentHarnessHostOwner;
export type AgentHarnessHostApprovalResult = NonNullable<
  Awaited<ReturnType<AgentHarnessHostCapabilities["waitForApproval"]>>
>;
export type HostToolSurfaceOptions = Parameters<
  NonNullable<AgentHarnessHostCapabilities["createToolSurfaceAsync"]>
>[0];

/** Owns opt-in construction snapshots and independent admitted child-tool lifetimes. */
export function prepareHarnessDelegatedToolHosts(params: {
  attempt: AgentHarnessHostAttempt;
  pluginId: string;
  config: AgentHarnessHostAttempt["config"];
  sourceCaller: ReturnType<typeof getGatewayToolCallerIdentity>;
  runtimePluginToolGrant: AgentHarnessHostAttempt["runtimePluginToolGrant"];
  githubPublicationAvailable: AgentHarnessHostAttempt["githubPublicationAvailable"];
  installationTarget: InstallationTarget | undefined;
  requiredNodeCommands: ReadonlySet<string>;
  nativeModelPolicySupport?: "exact";
  denyToolCalls: boolean;
  assertActive: () => void;
  createHost: AgentHarnessHostFactory;
}) {
  const {
    attempt,
    pluginId,
    config,
    sourceCaller,
    runtimePluginToolGrant,
    githubPublicationAvailable,
    installationTarget,
    requiredNodeCommands,
    nativeModelPolicySupport,
    denyToolCalls,
    assertActive,
    createHost,
  } = params;
  const { sessionKey } = attempt;
  const delegatedAttempt = {
    agentId: attempt.agentId,
    sessionId: attempt.sessionId,
    sessionKey: attempt.sessionKey,
    bootstrapWorkspaceDir: attempt.bootstrapWorkspaceDir,
    workspaceDir: attempt.workspaceDir,
    cwd: attempt.cwd,
    sandboxAgentId: attempt.sandboxAgentId,
    sessionRoot: attempt.sessionRoot,
    requireWorkspaceOnly: attempt.requireWorkspaceOnly,
    permissionMode: attempt.permissionMode,
    operation: attempt.operation,
    toolExecutionAllow: attempt.toolExecutionAllow
      ? cloneSnapshot(attempt.toolExecutionAllow)
      : undefined,
    messageChannel: attempt.messageChannel,
    messageProvider: attempt.messageProvider,
    currentMessagingTarget: attempt.currentMessagingTarget,
    currentChannelId: attempt.currentChannelId,
    currentThreadTs: attempt.currentThreadTs,
    agentAccountId: attempt.agentAccountId,
    senderId: attempt.senderId,
    senderIsOwner: attempt.senderIsOwner,
    memberRoleIds: attempt.memberRoleIds ? cloneSnapshot(attempt.memberRoleIds) : undefined,
    approvalReviewerDeviceId: attempt.approvalReviewerDeviceId,
    trigger: attempt.trigger,
    config,
    requesterOrigin:
      sourceCaller?.requesterOrigin || attempt.requesterOrigin
        ? cloneSnapshot(sourceCaller?.requesterOrigin ?? attempt.requesterOrigin)
        : undefined,
    runtimePluginToolGrant,
    githubPublicationAvailable,
    sandbox: attempt.sandbox,
  };
  let delegatedToolsPrepared = false;
  let delegatedSurfaceFailure: Error | undefined;
  let delegatedSurface:
    | Readonly<{
        options: HostToolSurfaceOptions;
        names: ReadonlySet<string>;
        bindingOptions?: Readonly<{ cwd?: string }>;
        readSourceTaint?: HostToolSurfaceOptions["isTurnTainted"];
        webFetchHostnameAllowlistRef?: HostToolSurfaceOptions["webFetchHostnameAllowlistRef"];
        memoryAudience?: HostToolSurfaceOptions["memoryAudience"];
      }>
    | undefined;
  const captureDelegatedSurface = (
    options: HostToolSurfaceOptions,
    sourceTools: AnyAgentTool[],
    bindingOptions?: Readonly<{ cwd?: string }>,
  ) => {
    if (!delegatedToolsPrepared || delegatedSurface || delegatedSurfaceFailure) {
      return;
    }
    try {
      delegatedSurface = {
        options: captureDelegatedToolOptions(options),
        names: new Set(sourceTools.map((tool) => tool.name)),
        bindingOptions: bindingOptions ? Object.freeze({ cwd: bindingOptions.cwd }) : undefined,
        // These are source policy/capability owners, not cloneable data. Read
        // late-bound policy and retain exact capability identity at issuance.
        readSourceTaint: options.isTurnTainted,
        webFetchHostnameAllowlistRef: options.webFetchHostnameAllowlistRef,
        memoryAudience: options.memoryAudience,
      };
    } catch (error) {
      // An unsupported transfer must not break the foreground tool surface.
      delegatedSurfaceFailure = new Error("prepared tool options cannot be delegated", {
        cause: error,
      });
    }
  };
  const capabilities: Pick<
    AgentHarnessHostCapabilities,
    "prepareDelegatedToolHosts" | "createDelegatedToolHost"
  > = {
    prepareDelegatedToolHosts: () => {
      assertActive();
      delegatedToolsPrepared = true;
    },
    createDelegatedToolHost: async ({ runId: childRunId, signal }) => {
      assertActive();
      if (delegatedSurfaceFailure) {
        throw delegatedSurfaceFailure;
      }
      if (
        sourceCaller?.workerTurnClaim ||
        sourceCaller?.workerTurnExecutionIdentityCapability ||
        sourceCaller?.receiptAdmissions?.length
      ) {
        throw new Error(
          "delegated tool hosts do not support worker-claim or settled-receipt sources",
        );
      }
      const surface = delegatedSurface;
      if (denyToolCalls || !surface || !config || !delegatedAttempt.agentId || !sessionKey) {
        throw new Error("delegated tool host requires its original prepared tool surface");
      }
      // Only values derived at issuance enter the child. Its closures must not
      // keep the foreground taint callback or mutable hostname policy ref.
      const { options: preparedOptions, names, bindingOptions, memoryAudience } = surface;
      const childTaint = createAgentTurnTaintState(surface.readSourceTaint?.() === true);
      const hostnamePolicy = surface.webFetchHostnameAllowlistRef
        ? cloneSnapshot({ value: surface.webFetchHostnameAllowlistRef.value })
        : undefined;
      // This synchronous acquisition precedes the first await and transfers
      // source custody, not the foreground host capability or receipt.
      const admission = prepareDelegatedAgentRunAdmission({
        cfg: config,
        parent: attempt.admittedRunContext,
        runId: childRunId,
        agentId: delegatedAttempt.agentId,
        signal,
      });
      let child: ReturnType<AgentHarnessHostFactory> | undefined;
      let releaseAudience: (() => void) | undefined;
      const cleanups = new Set<(reason: string) => Promise<void>>();
      let closing: Promise<void> | undefined;
      const close = () => {
        closing ??= (async () => {
          child?.close();
          try {
            const outcomes = await Promise.allSettled(
              [...cleanups].map((cleanup) =>
                Promise.resolve().then(() => cleanup("delegated-tool-host-closed")),
              ),
            );
            const failures = outcomes.flatMap((outcome) =>
              outcome.status === "rejected" ? [outcome.reason] : [],
            );
            if (failures.length) {
              throw new AggregateError(failures, "delegated tool host cleanup failed");
            }
          } finally {
            cleanups.clear();
            try {
              admission.close();
            } finally {
              releaseAudience?.();
            }
          }
        })();
        return closing;
      };
      try {
        releaseAudience = memoryAudience ? retainMemoryAudience(memoryAudience) : undefined;
        // Retention itself may call a source owner. Complete issuance while the
        // foreground host is still live, then use only the new owner.
        assertActive();
        const admittedRunContext = await admission.admit("plugin-harness", pluginId);
        child = withInstallationTarget(installationTarget, () =>
          createHost({
            attempt: {
              ...delegatedAttempt,
              sandbox: preparedOptions.sandbox ?? undefined,
              skillsSnapshot: preparedOptions.skillsSnapshot,
              onToolOutcome: (observation) => childTaint.observe(observation),
              admittedRunContext,
              runId: childRunId,
              abortSignal: signal,
            },
            pluginId,
            requiredNodeCommands: [...requiredNodeCommands],
            nativeModelPolicySupport,
          }),
        );
        const owner = child;
        const childCapabilities = owner.capabilities;
        const resolveGatewayContext = getGatewayContextResolver(admittedRunContext);
        // Admission retained the original source. Transport request/client and
        // per-tool invocation lifetimes must not become the child's authority.
        const runOwned = <T>(run: () => Promise<T>): Promise<T> =>
          runOutsideAgentPluginRuntimeRefresh(() =>
            runOutsideOperatorToolGatewayAuthority(() =>
              withPluginRuntimeGatewayContextResolver(
                resolveGatewayContext,
                () => owner.runWithCaller(run),
                { inheritRequestScope: false },
              ),
            ),
          );
        const bindOwnedTool = (tool: AnyAgentTool): AnyAgentTool =>
          wrapAgentToolExecutionContext(
            tool,
            (...args) => runOwned(() => tool.execute(...args)),
            runOwned,
            bindOwnedTool,
          );
        const create = childCapabilities.createToolSurfaceAsync?.bind(childCapabilities);
        const prepareMutableFileApproval =
          childCapabilities.prepareMutableFileApproval?.bind(childCapabilities);
        if (!create) {
          throw new Error("delegated tool host async construction is unavailable");
        }
        const hasRepliedRef = { value: false };
        const computerContextEpoch = { value: 0 };
        const delegatedCapabilities: AgentHarnessDelegatedToolHostCapabilities = Object.freeze({
          kind: childCapabilities.kind,
          version: childCapabilities.version,
          assertActive: childCapabilities.assertActive,
          computerContextEpoch,
          observeToolOutcome: (observation) => {
            childCapabilities.assertActive();
            childTaint.observe(observation);
          },
          bindToolSurface: (tools, options) =>
            runOutsideAgentPluginRuntimeRefresh(() =>
              childCapabilities.bindToolSurface(tools, options).map(bindOwnedTool),
            ),
          createToolSurfaceAsync: async () =>
            runOwned(async () => {
              const tools = await create(
                {
                  ...preparedOptions,
                  // Tool/provider preparation may update usage or OAuth state.
                  // Give each child an independent view with exact host provenance.
                  authProfileStore: preparedOptions.authProfileStore
                    ? cloneAuthProfileStore(preparedOptions.authProfileStore)
                    : undefined,
                  runId: childRunId,
                  abortSignal: signal,
                  hasRepliedRef,
                  memoryAudience,
                  webFetchHostnameAllowlistRef: hostnamePolicy,
                  isTurnTainted: childTaint.isTainted,
                  onToolOutcome: (observation) => childTaint.observe(observation),
                  computerContextEpoch,
                  computerExecutionId: childRunId,
                  registerRunCleanup: (cleanup) => {
                    childCapabilities.assertActive();
                    cleanups.add((reason) => runOwned(() => cleanup(reason)));
                  },
                  exec: {
                    ...preparedOptions.exec,
                    runId: childRunId,
                    scopeKey: childRunId,
                    operationalRunInstance: admittedRunContext.operationalRunInstance,
                  },
                },
                bindingOptions,
              );
              return tools.filter((tool) => names.has(tool.name)).map(bindOwnedTool);
            }),
          runBeforeToolCall: (request) =>
            runOwned(() => childCapabilities.runBeforeToolCall(request)),
          ...(prepareMutableFileApproval
            ? {
                prepareMutableFileApproval: (
                  request: Parameters<typeof prepareMutableFileApproval>[0],
                ) =>
                  runOwned(async () => {
                    const prepared = await prepareMutableFileApproval(request);
                    return prepared.ok
                      ? { ...prepared, revalidate: () => runOwned(() => prepared.revalidate()) }
                      : prepared;
                  }),
              }
            : {}),
          requestApproval: (request) => runOwned(() => childCapabilities.requestApproval(request)),
          waitForApproval: (request) => runOwned(() => childCapabilities.waitForApproval(request)),
        });
        return Object.freeze({ capabilities: delegatedCapabilities, close });
      } catch (error) {
        await close();
        throw error;
      }
    },
  };
  return { capabilities, captureSurface: captureDelegatedSurface };
}
