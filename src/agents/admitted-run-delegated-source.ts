import type { ExecutionIdentityAdmissionFacts } from "../audit/execution-identity-admission.js";
import {
  composeSessionSourceAssertion,
  type SessionSourceAssertion,
} from "../config/sessions/session-source-authority.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GatewayContextResolver } from "../gateway/server-methods/types.js";
import { getAgentRunLifecycleGeneration } from "../infra/agent-run-registry.js";
import {
  bindGatewayContextResolver,
  captureGatewayContextResolver,
} from "../plugins/runtime/gateway-context-binding.js";
import type { AdmittedRunOperatorAuthority } from "./admitted-run-operator-authority.types.js";
import {
  createOperationalRunInstanceRef,
  type OperationalRunInstanceRef,
} from "./operational-run-instance.js";

/** Owns detachable source custody; admission/lease lookup remains with the admitted-run owner. */
export function prepareRetainedDelegatedRunSource<T extends { close: () => void }>(
  params: {
    cfg: OpenClawConfig;
    runId: string;
    agentId: string;
    source: SessionSourceAssertion | undefined;
    operatorAuthority: AdmittedRunOperatorAuthority | undefined;
    lifecycleGeneration: ReturnType<typeof getAgentRunLifecycleGeneration>;
    gateway: GatewayContextResolver | undefined;
    signal?: AbortSignal;
  },
  prepare: (options: {
    cfg: OpenClawConfig;
    operationalRunInstance: OperationalRunInstanceRef;
    operatorAuthority?: AdmittedRunOperatorAuthority;
    assertSourceCurrent: SessionSourceAssertion;
    facts: Omit<ExecutionIdentityAdmissionFacts, "runtime">;
    onAdmitted: (context: object) => void;
  }) => T,
): Omit<T, "close"> & { close: () => void } {
  const gateway = captureGatewayContextResolver(params.gateway);
  let released = false;
  let releaseSource: (() => void) | undefined;
  const assertSourceCurrent = composeSessionSourceAssertion(
    [params.source],
    (assertSource) => {
      if (
        released ||
        getAgentRunLifecycleGeneration() !== params.lifecycleGeneration ||
        (gateway && gateway() === undefined)
      ) {
        throw new Error("delegated tool host source is no longer active");
      }
      params.signal?.throwIfAborted();
      assertSource();
    },
    { synchronousCheck: true },
  );
  try {
    // Never replace a refusing source with operator-only authority. Acquisition
    // is synchronous, before admission or any child construction can await.
    releaseSource = params.source?.retain?.();
    assertSourceCurrent();
    const prepared = prepare({
      cfg: params.cfg,
      operationalRunInstance: createOperationalRunInstanceRef(params.runId),
      operatorAuthority: params.operatorAuthority,
      assertSourceCurrent,
      facts: {
        runId: params.runId,
        agentId: params.agentId,
        ingress: { kind: "subagent", boundary: "agent-harness.delegated-tools", state: "present" },
      },
      onAdmitted: (context) => bindGatewayContextResolver(context, gateway),
    });
    return Object.freeze({
      ...prepared,
      close: () => {
        if (released) {
          return;
        }
        released = true;
        try {
          prepared.close();
        } finally {
          releaseSource?.();
        }
      },
    });
  } catch (error) {
    released = true;
    releaseSource?.();
    throw error;
  }
}
