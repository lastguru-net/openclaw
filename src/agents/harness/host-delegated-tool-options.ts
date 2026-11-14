import { cloneAuthProfileStore } from "../auth-profiles/clone.js";
import type { AgentHarnessHostCapabilities } from "./host-capability-types.js";
import { cloneHostSnapshot } from "./host-snapshot.js";

export function captureHostRuntimePluginToolGrant(
  source: Parameters<
    NonNullable<AgentHarnessHostCapabilities["createToolSurfaceAsync"]>
  >[0]["runtimePluginToolGrant"],
) {
  return source
    ? Object.freeze({
        pluginId: source.pluginId,
        toolNames: Object.freeze([...source.toolNames]),
      })
    : undefined;
}

type ToolOptions = Parameters<
  NonNullable<AgentHarnessHostCapabilities["createToolSurfaceAsync"]>
>[0];

/** Explicit data projection excludes foreground callbacks, receipts and mutable run state. */
export function captureDelegatedToolOptions(options: ToolOptions): ToolOptions {
  const data = cloneHostSnapshot({
    config: options.config,
    agentId: options.agentId,
    policyAgentId: options.policyAgentId,
    agentDir: options.agentDir,
    sessionKey: options.sessionKey,
    runSessionKey: options.runSessionKey,
    sessionId: options.sessionId,
    requesterOrigin: options.requesterOrigin,
    operatorProfileId: options.operatorProfileId,
    conversationId: options.conversationId,
    messageChannel: options.messageChannel,
    messageProvider: options.messageProvider,
    agentAccountId: options.agentAccountId,
    senderIsOwner: options.senderIsOwner,
    senderId: options.senderId,
    senderName: options.senderName,
    senderUsername: options.senderUsername,
    senderE164: options.senderE164,
    memberRoleIds: options.memberRoleIds,
    groupId: options.groupId,
    groupChannel: options.groupChannel,
    groupSpace: options.groupSpace,
    spawnedBy: options.spawnedBy,
    chatType: options.chatType,
    currentChannelId: options.currentChannelId,
    currentThreadTs: options.currentThreadTs,
    currentMessagingTarget: options.currentMessagingTarget,
    currentMessageId: options.currentMessageId,
    nativeChannelId: options.nativeChannelId,
    messageTo: options.messageTo,
    messageThreadId: options.messageThreadId,
    replyToMode: options.replyToMode,
    requireExplicitMessageTarget: options.requireExplicitMessageTarget,
    messageToolFinalByDefault: options.messageToolFinalByDefault,
    sourceReplyDeliveryMode: options.sourceReplyDeliveryMode,
    taskSuggestionDeliveryMode: options.taskSuggestionDeliveryMode,
    channelContext: options.channelContext,
    approvalReviewerDeviceId: options.approvalReviewerDeviceId,
    bootstrapUserProfileId: options.bootstrapUserProfileId,
    gatewayUiCommandTarget: options.gatewayUiCommandTarget,
    pinnedWidgetAuthoring: options.pinnedWidgetAuthoring,
    clientCaps: options.clientCaps,
    listingClientCaps: options.listingClientCaps,
    toolPolicyMessageProvider: options.toolPolicyMessageProvider,
    conversationToolPolicy: options.conversationToolPolicy,
    toolBindings: options.toolBindings,
    conversationCapabilityProfile: options.conversationCapabilityProfile,
    inputProvenance: options.inputProvenance,
    runtimeToolAllowlist: options.runtimeToolAllowlist,
    inheritRuntimeToolAllowlist: options.inheritRuntimeToolAllowlist,
    runtimePluginToolGrant: options.runtimePluginToolGrant,
    toolConstructionPlan: options.toolConstructionPlan,
    includeCoreTools: options.includeCoreTools,
    includeToolSearchControls: options.includeToolSearchControls,
    disableMessageTool: options.disableMessageTool,
    forceMessageTool: options.forceMessageTool,
    workspaceDir: options.workspaceDir,
    cwd: options.cwd,
    spawnWorkspaceDir: options.spawnWorkspaceDir,
    requireWorkspaceOnly: options.requireWorkspaceOnly,
    sessionPermissionPolicy: options.sessionPermissionPolicy,
    modelApi: options.modelApi,
    modelBaseUrl: options.modelBaseUrl,
    modelParams: options.modelParams,
    modelCompat: options.modelCompat,
    modelAuthMode: options.modelAuthMode,
    modelProvider: options.modelProvider,
    modelId: options.modelId,
    modelAuthProfileId: options.modelAuthProfileId,
    modelHasVision: options.modelHasVision,
    modelContextWindowTokens: options.modelContextWindowTokens,
    webSearchModelSelection: options.webSearchModelSelection,
    suppressManagedWebSearch: options.suppressManagedWebSearch,
    webSearchEnabled: options.webSearchEnabled,
    requesterThinkingLevel: options.requesterThinkingLevel,
    requesterModel: options.requesterModel,
    gitContributorProfileId: options.gitContributorProfileId,
    trigger: options.trigger,
    jobId: options.jobId,
    scheduledToolPolicy: options.scheduledToolPolicy,
    memoryFlush: options.memoryFlush,
    inboundEventKind: options.inboundEventKind,
    skillsSnapshot: options.skillsSnapshot,
    skillUsagePaths: options.skillUsagePaths,
    sessionConfigSource: options.sessionConfigSource,
    githubPublicationAvailable: options.githubPublicationAvailable,
    cronCreatorAuthorityUnavailableReason: options.cronCreatorAuthorityUnavailableReason,
    oneShotCliRun: options.oneShotCliRun,
    exec: options.exec
      ? {
          host: options.exec.host,
          security: options.exec.security,
          ask: options.exec.ask,
          mode: options.exec.mode,
          bypassHostApprovalFloors: options.exec.bypassHostApprovalFloors,
          trigger: options.exec.trigger,
          pathPrepend: options.exec.pathPrepend,
          safeBins: options.exec.safeBins,
          strictInlineEval: options.exec.strictInlineEval,
          commandHighlighting: options.exec.commandHighlighting,
          safeBinTrustedDirs: options.exec.safeBinTrustedDirs,
          safeBinProfiles: options.exec.safeBinProfiles,
          reviewer: options.exec.reviewer,
          preparedStoreEnvironment: options.exec.preparedStoreEnvironment,
          preparedSubagentExecution: options.exec.preparedSubagentExecution,
          executionAgentId: options.exec.executionAgentId,
          backgroundMs: options.exec.backgroundMs,
          cleanupMs: options.exec.cleanupMs,
          timeoutSec: options.exec.timeoutSec,
          approvalWarningText: options.exec.approvalWarningText,
          approvalFollowupText: options.exec.approvalFollowupText,
          approvalFollowupMode: options.exec.approvalFollowupMode,
          approvalRunningNoticeMs: options.exec.approvalRunningNoticeMs,
          sandboxRequired: options.exec.sandboxRequired,
          elevated: options.exec.elevated,
          allowBackground: options.exec.allowBackground,
          notifySessionKey: options.exec.notifySessionKey,
          sessionStore: options.exec.sessionStore,
          eventRouting: options.exec.eventRouting,
          messageProvider: options.exec.messageProvider,
          currentChannelId: options.exec.currentChannelId,
          currentMessagingTarget: options.exec.currentMessagingTarget,
          currentThreadTs: options.exec.currentThreadTs,
          channelContext: options.exec.channelContext,
          accountId: options.exec.accountId,
          approvalReviewerDeviceId: options.exec.approvalReviewerDeviceId,
          nonInteractiveApproval: options.exec.nonInteractiveApproval,
          notifyOnExit: options.exec.notifyOnExit,
          notifyOnExitEmptySuccess: options.exec.notifyOnExitEmptySuccess,
          cwd: options.exec.cwd,
          inputWaitIdleMs: options.exec.inputWaitIdleMs,
          node: options.exec.node,
          nodeCwd: options.exec.nodeCwd,
        }
      : undefined,
  } satisfies ToolOptions);
  return {
    ...data,
    // The selected host auth view can contain external overlays and private
    // credential provenance that structuredClone would discard.
    authProfileStore: options.authProfileStore
      ? cloneAuthProfileStore(options.authProfileStore)
      : undefined,
    exec: data.exec ? { ...data.exec, sandbox: options.exec?.sandbox } : undefined,
    // The prepared sandbox bridge is an existing source owner, not a callback
    // into the foreground attempt. Its original source must remain current.
    sandbox: options.sandbox
      ? Object.freeze({ ...options.sandbox, tools: cloneHostSnapshot(options.sandbox.tools) })
      : options.sandbox,
  };
}
