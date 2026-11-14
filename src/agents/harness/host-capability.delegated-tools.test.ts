import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, vi } from "vitest";
import {
  composeSessionSourceAssertion,
  type SessionSourceAssertion,
} from "../../config/sessions/session-source-authority.js";
import {
  captureOwnedTranscriptWriteAssertion,
  withOwnedSessionTranscriptWrites,
} from "../../config/sessions/transcript-write-context.js";
import {
  resetAgentRunRegistryForTest,
  rotateAgentRunRegistryLifecycleGeneration,
} from "../../infra/agent-run-registry.js";
import {
  createAdmittedRunOperatorAuthority,
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
} from "../admitted-run-context.js";
import * as agentTools from "../agent-tools.async.js";
import {
  continueAuthProfileAuthorization,
  continueAuthProfileAuthorizationInheritance,
  takeAuthProfileAuthorizationWriteIntents,
} from "../auth-profiles/authorization-lifetime.js";
import {
  observeCachedCanonicalAuthProfileCredentials,
  observeCanonicalAuthProfileCredentials,
  withCanonicalAuthProfileCredentialObserver,
  type CanonicalAuthProfileCredentialObservation,
} from "../auth-profiles/credential-observation.js";
import type { AuthProfileStore } from "../auth-profiles/types.js";
import {
  createAdmittedGatewayToolCallerIdentity,
  getGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../tools/gateway-caller-context.js";
import { createAgentHarnessHostCapabilities } from "./host-capability.js";
import { testTool } from "./host-capability.shard.test-support.js";
import * as delegatedOptions from "./host-delegated-tool-options.js";

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup();
  }
  vi.restoreAllMocks();
  resetAgentRunRegistryForTest();
});

async function parentFixture(
  options: {
    requireWorkspaceOnly?: true;
    restrictedSource?: "worker" | "receipt";
    transcriptSource?: true;
  } = {},
) {
  let foregroundEnded = false;
  let revoked = false;
  let sourceHolds = 0;
  const source: SessionSourceAssertion = Object.assign(
    () => {
      if (revoked || (foregroundEnded && sourceHolds === 0)) {
        throw new Error("original source has ended");
      }
    },
    {
      retain: () => {
        sourceHolds += 1;
        let released = false;
        return () => {
          if (!released) {
            released = true;
            sourceHolds -= 1;
          }
        };
      },
    },
  );
  const target = {
    agentId: "main",
    sessionKey: "agent:main:original",
    sessionId: "physical-session",
    storePath: "/tmp/openclaw-delegated-source/main.sqlite",
  };
  const sourceAssertion = options.transcriptSource
    ? await withOwnedSessionTranscriptWrites(
        {
          sessionTarget: target,
          assertCommitAllowed: composeSessionSourceAssertion([source]),
          withTranscriptWrite: async (run) => await run(),
        },
        async () => captureOwnedTranscriptWriteAssertion(target),
      )
    : source;
  const operator = createAdmittedRunOperatorAuthority({
    profileId: "original-person",
    scopes: ["operator.write"],
    assertCurrent: () => {
      if (revoked) {
        throw new Error("original operator has ended");
      }
    },
  });
  const config = { tools: { profile: "coding" as const } };
  const admission = prepareAgentRunAdmission({
    cfg: config,
    operationalRunInstance: createOperationalRunInstanceRef("foreground"),
    facts: {
      runId: "foreground",
      agentId: "main",
      ingress: { kind: "channel", boundary: "delegated-host-test", state: "present" },
    },
    operatorAuthority: operator,
    assertSourceCurrent: sourceAssertion,
  });
  cleanups.push(admission.close);
  const admittedRunContext = await admission.admit("plugin-harness", "codex");
  const caller = expectDefined(
    createAdmittedGatewayToolCallerIdentity({
      admittedRunContext,
      agentId: "main",
      sessionKey: "agent:main:original",
    }),
    "admitted caller",
  );
  if (options.restrictedSource === "worker") {
    caller.workerTurnClaim = {
      sessionId: "physical-session",
      claimId: "worker-claim",
      runId: "foreground",
      placementGeneration: 1,
      owner: { kind: "worker", environmentId: "worker-env", ownerEpoch: 1 },
    };
  } else if (options.restrictedSource === "receipt") {
    caller.receiptAdmissions = [
      {
        async prepare() {
          throw new Error("settled receipt must not be borrowed by a child");
        },
      },
    ];
  }
  const host = await withGatewayToolCallerIdentity(caller, () =>
    createAgentHarnessHostCapabilities({
      pluginId: "codex",
      attempt: {
        admittedRunContext,
        runId: "foreground",
        agentId: "main",
        sessionId: "physical-session",
        sessionKey: "agent:main:original",
        cwd: "/workspace",
        workspaceDir: "/workspace",
        sessionRoot: "/workspace",
        permissionMode: "read-only",
        requireWorkspaceOnly: options.requireWorkspaceOnly,
        config,
        requesterOrigin: { sessionKey: "agent:main:original", senderId: "original-sender" },
      },
    }),
  );
  cleanups.push(host.close);
  return {
    host,
    config,
    sourceHolds: () => sourceHolds,
    revoke: () => {
      revoked = true;
    },
    endForeground: () => {
      host.close();
      admission.close();
      foregroundEnded = true;
    },
  };
}

it("does not capture or clone delegation options on the default foreground path", async () => {
  const parent = await parentFixture();
  const { tool } = testTool();
  vi.spyOn(agentTools, "createOpenClawCodingToolsInternalAsync").mockResolvedValue([tool]);
  const capture = vi.spyOn(delegatedOptions, "captureDelegatedToolOptions");
  await parent.host.capabilities.createToolSurfaceAsync!({
    config: parent.config,
    installedSkills: [
      {
        name: "fixture",
        description: "fixture",
        location: "/skill",
        source: { filePath: "/skill" },
        assertCurrent: () => {},
      },
    ],
  });
  expect(capture).not.toHaveBeenCalled();
  await expect(
    parent.host.capabilities.createDelegatedToolHost!({ runId: "child" }),
  ).rejects.toThrow("original prepared tool surface");
});

it("keeps unsupported delegated snapshots from breaking foreground construction", async () => {
  const parent = await parentFixture();
  const { tool } = testTool();
  vi.spyOn(agentTools, "createOpenClawCodingToolsInternalAsync").mockResolvedValue([tool]);
  parent.host.capabilities.prepareDelegatedToolHosts!();
  await expect(
    parent.host.capabilities.createToolSurfaceAsync!({
      config: parent.config,
      modelParams: { unsupportedCallback: () => {} },
    }),
  ).resolves.toHaveLength(1);
  await expect(
    parent.host.capabilities.createDelegatedToolHost!({ runId: "child" }),
  ).rejects.toThrow("prepared tool options cannot be delegated");
});

it("retains production transcript source custody across foreground close and uses a new caller owner", async () => {
  const parent = await parentFixture({ transcriptSource: true });
  const { tool } = testTool(
    vi.fn(async () => {
      const caller = getGatewayToolCallerIdentity();
      return {
        content: [],
        details: {
          runId: caller?.operationalRunInstance?.runId,
          profileId: caller?.operatorAuthority?.profileId,
          sessionKey: caller?.sessionKey,
        },
      };
    }),
  );
  vi.spyOn(agentTools, "createOpenClawCodingToolsInternalAsync").mockResolvedValue([tool]);
  parent.host.capabilities.prepareDelegatedToolHosts!();
  await parent.host.capabilities.createToolSurfaceAsync!({ config: parent.config });
  const child = await parent.host.capabilities.createDelegatedToolHost!({ runId: "child" });
  cleanups.push(child.close);
  expect(parent.sourceHolds()).toBe(1);
  parent.endForeground();
  const tools = await child.capabilities.createToolSurfaceAsync();
  const read = expectDefined(tools[0], "child read tool");
  await expect(read.execute("call", {})).resolves.toMatchObject({
    details: { runId: "child", profileId: "original-person", sessionKey: "agent:main:original" },
  });
  await child.close();
  expect(parent.sourceHolds()).toBe(0);
  await expect(read.execute("after-close", {})).rejects.toThrow("no longer active");
});

it("uses host-pinned workspace policy and child-owned cleanup without retaining parent callbacks", async () => {
  const parent = await parentFixture({ requireWorkspaceOnly: true });
  const { tool } = testTool();
  const construction = vi
    .spyOn(agentTools, "createOpenClawCodingToolsInternalAsync")
    .mockResolvedValue([tool]);
  const parentCleanup = vi.fn();
  const parentOutcome = vi.fn();
  const parentYield = vi.fn();
  const parentComputerEpoch = { value: 7 };
  parent.host.capabilities.prepareDelegatedToolHosts!();
  await parent.host.capabilities.createToolSurfaceAsync!({
    config: {},
    registerRunCleanup: parentCleanup,
    onToolOutcome: parentOutcome,
    onYield: parentYield,
    computerContextEpoch: parentComputerEpoch,
    hasRepliedRef: { value: true },
  });
  const child = await parent.host.capabilities.createDelegatedToolHost!({ runId: "child" });
  cleanups.push(child.close);
  parent.endForeground();
  await child.capabilities.createToolSurfaceAsync({
    config: { tools: { profile: "full" } },
    sessionKey: "agent:main:other",
    workspaceDir: "/escape",
    sessionPermissionPolicy: { root: "/escape", mode: "full" },
  });
  const options = expectDefined(construction.mock.calls.at(-1)?.[0], "child construction inputs");
  expect(options).toMatchObject({
    config: parent.config,
    workspaceDir: "/workspace",
    sessionPermissionPolicy: { root: "/workspace", mode: "read-only" },
    hasRepliedRef: { value: false },
    runId: "child",
  });
  expect(options.computerContextEpoch).toBe(child.capabilities.computerContextEpoch);
  expect(options.computerContextEpoch).not.toBe(parentComputerEpoch);
  expect(child.capabilities.computerContextEpoch).toEqual({ value: 0 });
  expect(options.onToolOutcome).not.toBe(parentOutcome);
  expect(options.onYield).toBeUndefined();
  expect(options.registerRunCleanup).not.toBe(parentCleanup);
  const cleanup = vi.fn(async () => {});
  options.registerRunCleanup!(cleanup);
  await child.close();
  await child.close();
  expect(cleanup).toHaveBeenCalledExactlyOnceWith("delegated-tool-host-closed");
  expect(parentCleanup).not.toHaveBeenCalled();
  expect(parentOutcome).not.toHaveBeenCalled();
  expect(parentYield).not.toHaveBeenCalled();
});

it.each(["source", "generation", "signal"] as const)(
  "fences the next child effect after %s revocation",
  async (kind) => {
    const parent = await parentFixture();
    const { tool, execute } = testTool();
    vi.spyOn(agentTools, "createOpenClawCodingToolsInternalAsync").mockResolvedValue([tool]);
    parent.host.capabilities.prepareDelegatedToolHosts!();
    await parent.host.capabilities.createToolSurfaceAsync!({ config: parent.config });
    const controller = new AbortController();
    const child = await parent.host.capabilities.createDelegatedToolHost!({
      runId: "child",
      signal: controller.signal,
    });
    cleanups.push(child.close);
    const read = expectDefined(
      (await child.capabilities.createToolSurfaceAsync())[0],
      "child read tool",
    );
    parent.endForeground();
    if (kind === "source") {
      parent.revoke();
    } else if (kind === "generation") {
      rotateAgentRunRegistryLifecycleGeneration();
    } else {
      controller.abort();
    }
    await expect(read.execute("revoked", {})).rejects.toThrow();
    expect(execute).not.toHaveBeenCalled();
  },
);

it.each(["worker", "receipt"] as const)(
  "names the unsupported %s source instead of borrowing it",
  async (restrictedSource) => {
    const parent = await parentFixture({ restrictedSource });
    const { tool } = testTool();
    vi.spyOn(agentTools, "createOpenClawCodingToolsInternalAsync").mockResolvedValue([tool]);
    parent.host.capabilities.prepareDelegatedToolHosts!();
    await parent.host.capabilities.createToolSurfaceAsync!({ config: parent.config });
    await expect(
      parent.host.capabilities.createDelegatedToolHost!({ runId: "child" }),
    ).rejects.toThrow("do not support worker-claim or settled-receipt sources");
    expect(parent.sourceHolds()).toBe(0);
  },
);

it("reads taint and hostname restrictions at issuance and then uses child-owned state", async () => {
  const parent = await parentFixture();
  const { tool } = testTool();
  const construction = vi
    .spyOn(agentTools, "createOpenClawCodingToolsInternalAsync")
    .mockResolvedValue([tool]);
  let parentTainted = false;
  const readTaint = vi.fn(() => parentTainted);
  const hostnames: { value?: string[] } = {};
  parent.host.capabilities.prepareDelegatedToolHosts!();
  await parent.host.capabilities.createToolSurfaceAsync!({
    config: parent.config,
    isTurnTainted: readTaint,
    webFetchHostnameAllowlistRef: hostnames,
  });
  expect(readTaint).not.toHaveBeenCalled();
  parentTainted = true;
  hostnames.value = ["allowed.example"];
  const child = await parent.host.capabilities.createDelegatedToolHost!({ runId: "child" });
  cleanups.push(child.close);
  expect(readTaint).toHaveBeenCalledOnce();
  parent.endForeground();
  parentTainted = false;
  hostnames.value = ["different.example"];
  await child.capabilities.createToolSurfaceAsync();
  const options = expectDefined(construction.mock.calls.at(-1)?.[0], "child options");
  expect(options.webFetchHostnameAllowlistRef?.value).toEqual(["allowed.example"]);
  expect(options.isTurnTainted?.()).toBe(true);
  expect(readTaint).toHaveBeenCalledOnce();
});

it("taints a previously clean child after its own native or MCP network outcome", async () => {
  const parent = await parentFixture();
  const { tool } = testTool();
  const construction = vi
    .spyOn(agentTools, "createOpenClawCodingToolsInternalAsync")
    .mockResolvedValue([tool]);
  parent.host.capabilities.prepareDelegatedToolHosts!();
  await parent.host.capabilities.createToolSurfaceAsync!({
    config: parent.config,
    isTurnTainted: () => false,
  });
  const child = await parent.host.capabilities.createDelegatedToolHost!({ runId: "child" });
  cleanups.push(child.close);
  parent.endForeground();
  await child.capabilities.createToolSurfaceAsync();
  const options = expectDefined(construction.mock.calls.at(-1)?.[0], "child options");
  expect(options.isTurnTainted?.()).toBe(false);
  child.capabilities.observeToolOutcome({
    toolName: "native-web-search",
    argsHash: "args",
    resultHash: "network",
    resultContentSource: "network",
  });
  expect(options.isTurnTainted?.()).toBe(true);
  options.onToolOutcome?.({ toolName: "read", argsHash: "args2", resultHash: "local" });
  expect(options.isTurnTainted?.()).toBe(true);
});

it("releases source custody when memory audience retention refuses an unbranded capability", async () => {
  const parent = await parentFixture();
  const { tool } = testTool();
  vi.spyOn(agentTools, "createOpenClawCodingToolsInternalAsync").mockResolvedValue([tool]);
  parent.host.capabilities.prepareDelegatedToolHosts!();
  await parent.host.capabilities.createToolSurfaceAsync!({
    config: parent.config,
    memoryAudience: { kind: "owner-private", agentId: "main" },
  });
  await expect(
    parent.host.capabilities.createDelegatedToolHost!({ runId: "child" }),
  ).rejects.toThrow("not minted");
  expect(parent.sourceHolds()).toBe(0);
});

it("keeps selected auth overlays and exact private provenance in independent child views", async () => {
  const parent = await parentFixture();
  const { tool } = testTool();
  const construction = vi
    .spyOn(agentTools, "createOpenClawCodingToolsInternalAsync")
    .mockResolvedValue([tool]);
  const previous = { type: "api_key" as const, provider: "fixture", key: "synthetic-previous" };
  const canonical = continueAuthProfileAuthorization(previous, {
    ...previous,
    key: "synthetic-canonical",
  });
  const authProfileStore: AuthProfileStore = {
    version: 1,
    profiles: {
      canonical,
      external: {
        type: "oauth",
        provider: "openai",
        access: "synthetic-external-access",
        refresh: "synthetic-external-refresh",
        expires: 4_102_444_800_000,
      },
    },
    runtimeExternalProfileIds: ["external"],
    runtimeExternalProfileIdsAuthoritative: true,
  };
  observeCanonicalAuthProfileCredentials("/synthetic/canonical.sqlite", { canonical });
  continueAuthProfileAuthorizationInheritance(authProfileStore.profiles, "canonical", previous);
  parent.host.capabilities.prepareDelegatedToolHosts!();
  await parent.host.capabilities.createToolSurfaceAsync!({
    config: parent.config,
    authProfileStore,
  });
  // Captured authority is not a later mutation of the caller's original view.
  authProfileStore.profiles.canonical = { ...previous, key: "synthetic-replacement" };
  const first = await parent.host.capabilities.createDelegatedToolHost!({
    runId: "auth-child-one",
  });
  cleanups.push(first.close);
  const second = await parent.host.capabilities.createDelegatedToolHost!({
    runId: "auth-child-two",
  });
  cleanups.push(second.close);
  parent.endForeground();
  await first.capabilities.createToolSurfaceAsync();
  const firstStore = expectDefined(
    construction.mock.calls.at(-1)?.[0]?.authProfileStore,
    "first auth",
  );
  await second.capabilities.createToolSurfaceAsync();
  const secondStore = expectDefined(
    construction.mock.calls.at(-1)?.[0]?.authProfileStore,
    "second auth",
  );
  expect(firstStore).not.toBe(authProfileStore);
  expect(secondStore).not.toBe(firstStore);
  expect(secondStore).toMatchObject({
    profiles: { canonical, external: { access: "synthetic-external-access" } },
    runtimeExternalProfileIds: ["external"],
    runtimeExternalProfileIdsAuthoritative: true,
  });
  const observations: CanonicalAuthProfileCredentialObservation[] = [];
  await withCanonicalAuthProfileCredentialObserver(
    (value) => observations.push(value),
    async () => {
      observeCachedCanonicalAuthProfileCredentials(secondStore.profiles);
    },
  );
  expect(observations).toEqual([
    { databasePath: "/synthetic/canonical.sqlite", profiles: { canonical } },
  ]);
  expect(takeAuthProfileAuthorizationWriteIntents(secondStore.profiles)).toEqual([
    { profileId: "canonical", inherited: false, intent: { kind: "refresh", previous } },
    { profileId: "canonical", inherited: true, intent: { kind: "refresh", previous } },
  ]);
  firstStore.profiles.canonical = { ...previous, key: "synthetic-child-change" };
  expect(secondStore.profiles.canonical).toEqual(canonical);
});
