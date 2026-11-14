import { toolPolicy } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { CodexPluginConfig } from "./config.js";

// These tools act on the foreground source, its reply, or its managed run. A
// native child has no independent OpenClaw conversation/control owner for them.
const FOREGROUND_CHILD_TOOLS = new Set([
  "ask_user",
  "create_goal",
  "get_goal",
  "update_goal",
  "progress_card",
  "message",
  "openclaw",
  // Personal authoring binds once to its foreground admitted run and requester.
  "skill_library",
  "session_status",
  "sessions",
  "sessions_create",
  "sessions_spawn",
  "sessions_send",
  "sessions_yield",
  "agents_wait",
  "subagents",
  "automations",
]);

// These Codex process/placement projections are not reconstructed by the raw
// host tool factory. Native child shell tools remain independently available.
const FOREGROUND_PROCESS_TOOLS = new Set([
  "exec",
  "process",
  "gateway_exec",
  "gateway_process",
  "node_exec",
  "sandbox_exec",
  "sandbox_process",
]);

export type CodexNativeChildToolDescriptor = {
  name: string;
  pluginId?: string;
  mcpServerName?: string;
  unsupportedReason?: string;
};

export type CodexNativeChildToolStatus = "allowed" | "denied" | "unavailable" | "unsupported";

/** Inspect the same finite surface used for execution; never discovers or calls a tool. */
export function inspectCodexNativeChildTools(
  policy: CodexPluginConfig["nativeChildTools"],
  availableTools: readonly CodexNativeChildToolDescriptor[],
  registeredTools: readonly CodexNativeChildToolDescriptor[] = availableTools,
) {
  const allow = policy?.allow?.filter((pattern) => pattern.trim()) ?? [];
  const deny = policy?.deny ?? [];
  const matches = toolPolicy.createToolPolicyMatcher({ allow, deny }, false);
  const available = new Map(availableTools.map((tool) => [tool.name, tool]));
  const tools = [
    ...new Map([...registeredTools, ...availableTools].map((tool) => [tool.name, tool])).values(),
  ]
    .map((tool) => {
      const unsupportedReason =
        tool.unsupportedReason ??
        (FOREGROUND_CHILD_TOOLS.has(tool.name)
          ? "This tool requires a foreground conversation, reply, or control owner."
          : FOREGROUND_PROCESS_TOOLS.has(tool.name)
            ? "Codex host process projections are not delegated; use the child's native shell."
            : undefined);
      const status: CodexNativeChildToolStatus = unsupportedReason
        ? "unsupported"
        : !available.has(tool.name)
          ? "unavailable"
          : allow.length > 0 && matches(tool.name)
            ? "allowed"
            : "denied";
      return Object.assign({}, tool, { status }, unsupportedReason ? { unsupportedReason } : {});
    })
    .toSorted((a, b) => a.name.localeCompare(b.name));
  const unmatched = (patterns: readonly string[]) =>
    patterns.filter((pattern) => {
      const match = toolPolicy.createToolPolicyMatcher({ allow: [pattern] }, false);
      return !tools.some((tool) => match(tool.name));
    });
  return { tools, unmatchedAllow: unmatched(allow), unmatchedDeny: unmatched(deny) };
}
