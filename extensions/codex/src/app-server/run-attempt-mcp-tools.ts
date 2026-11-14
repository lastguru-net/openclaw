import {
  materializeRequesterScopedMcpToolsForHarnessRun,
  type EmbeddedRunAttemptParams,
  type ExecApprovalDecision,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  formatMcpCodexApprovalRemedy,
  materializeStaticMcpToolsForHarnessRun,
} from "openclaw/plugin-sdk/codex-mcp-projection";
import { requestPluginApprovalOutcome } from "./plugin-approval-roundtrip.js";

type ConfiguredMcpOptions = Parameters<typeof materializeStaticMcpToolsForHarnessRun>[0];
type ScopedMcpOptions = Parameters<typeof materializeRequesterScopedMcpToolsForHarnessRun>[0];
type McpOwner = {
  runId: string;
  hostCapabilities: NonNullable<EmbeddedRunAttemptParams["hostCapabilities"]>;
};
type OwnedMcpOptions<T> = Omit<T, "requestInteractiveCodexApproval"> & {
  policyContext: NonNullable<ScopedMcpOptions["policyContext"]>;
  reservedToolNames: NonNullable<ScopedMcpOptions["reservedToolNames"]>;
};
type HarnessMcpInteractiveApproval = NonNullable<
  ScopedMcpOptions["requestInteractiveCodexApproval"]
>;

async function requestInteractiveMcpApproval(
  approval: Parameters<HarnessMcpInteractiveApproval>[0],
  allowedDecisions: ExecApprovalDecision[],
  hostCapabilities: McpOwner["hostCapabilities"],
) {
  const outcome = await requestPluginApprovalOutcome({
    hostCapabilities,
    signal: approval.signal,
    title: `Run MCP tool ${approval.serverName}/${approval.toolName}`,
    description: `Codex approval mode "${approval.mode}" requires an operator decision before this MCP tool runs. ${formatMcpCodexApprovalRemedy(approval.serverName)}`,
    allowedDecisions,
    toolName: approval.safeToolName,
    toolCallId: approval.toolCallId,
    mcpTool: { server: approval.serverName, tool: approval.toolName },
    isMcpToolApprovalActive: approval.isActive,
  });
  if (outcome !== "approved-once" && outcome !== "approved-session") {
    throw new Error(
      `${approval.serverName}/${approval.toolName}: interactive Codex approval (${approval.mode}) was not granted: ${outcome}`,
    );
  }
}

// Each materialization owns its leases and approval capability. Children must
// not borrow foreground executors which dispose when the parent completes.
export function createCodexOwnedMcpMaterializer(options: {
  configured?: OwnedMcpOptions<ConfiguredMcpOptions>;
  requesterScoped?: OwnedMcpOptions<ScopedMcpOptions>;
  interactiveConfiguredApproval: boolean;
}) {
  return async (owner: McpOwner) => {
    let configured: Awaited<ReturnType<typeof materializeStaticMcpToolsForHarnessRun>> | undefined;
    try {
      configured = options.configured
        ? await materializeStaticMcpToolsForHarnessRun({
            ...options.configured,
            policyContext: { ...options.configured.policyContext, runId: owner.runId },
            ...(options.interactiveConfiguredApproval
              ? {
                  requestInteractiveCodexApproval: (approval) =>
                    requestInteractiveMcpApproval(
                      approval,
                      approval.mode === "prompt"
                        ? ["allow-once", "deny"]
                        : ["allow-once", "allow-always", "deny"],
                      owner.hostCapabilities,
                    ),
                }
              : {}),
          })
        : undefined;
      // Requester-scoped MCP: dynamic tools on a shared thread (never harness-native MCP).
      // Specs come from the session advertised-catalog cache so fingerprints stay stable.
      const scoped = options.requesterScoped
        ? await materializeRequesterScopedMcpToolsForHarnessRun({
            ...options.requesterScoped,
            policyContext: { ...options.requesterScoped.policyContext, runId: owner.runId },
            // Requester servers cannot consume stored grants; Allow Always would re-prompt.
            requestInteractiveCodexApproval: (approval) =>
              requestInteractiveMcpApproval(
                approval,
                ["allow-once", "deny"],
                owner.hostCapabilities,
              ),
            reservedToolNames: [
              ...options.requesterScoped.reservedToolNames,
              ...(configured?.tools.map((tool) => tool.name) ?? []),
            ],
          })
        : undefined;
      return { configured, scoped };
    } catch (error) {
      await configured?.dispose();
      throw error;
    }
  };
}
