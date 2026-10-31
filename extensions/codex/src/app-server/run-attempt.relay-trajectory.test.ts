import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { setHostToolFactoryForTest } from "openclaw/plugin-sdk/agent-runtime-test-contracts";
import { initializeGlobalHookRunner } from "openclaw/plugin-sdk/hook-runtime";
import {
  createAgentHarnessHostCapabilitiesForTest,
  createMockPluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import {
  createTrajectoryRuntimeRecorderForTest,
  loadSqliteTrajectoryRuntimeEvents,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { expect, it, vi } from "vitest";
import { readAttemptTerminal } from "./attempt-terminal.test-helper.js";
import { CODEX_INFERENCE_GENERATION_KEY } from "./inference-context.js";
import { getCodexInferenceThread, ownCodexInferenceClient } from "./inference-routing.js";
import { isJsonObject } from "./protocol.js";
import {
  createCodexRuntimePlanFixture,
  createParams,
  createRuntimeDynamicTool,
  createStartedThreadHarness,
  runCodexAppServerAttempt,
  setCodexTestModelSupportsTools,
  setupRunAttemptTestHooks,
  tempDir,
  threadStartResult,
} from "./run-attempt-test-harness.js";
import { attachSqliteSessionTarget } from "./sqlite-session.test-helpers.js";

setupRunAttemptTestHooks();

it("persists each current relay instruction block once without adding it to native RPCs", async () => {
  vi.stubEnv("OPENCLAW_TRAJECTORY", "1");
  const workspaceDir = path.join(tempDir, "workspace");
  await fs.mkdir(workspaceDir, { recursive: true });
  const persona = "Synthetic relay persona: explain results precisely.";
  const skills = "<available_skills>synthetic-relay-skill</available_skills>";
  const persistent = "Persistent synthetic relay policy.";
  await fs.writeFile(path.join(workspaceDir, "SOUL.md"), persona);
  const snapshots = [
    { conversation: "Synthetic group conversation instructions.", tool: "relay_alpha" },
    { conversation: "Synthetic direct conversation instructions.", tool: "relay_alpha" },
    { conversation: undefined, tool: "relay_beta" },
  ];
  let prefix = "";
  let suffix = "";
  initializeGlobalHookRunner(
    createMockPluginRegistry([
      {
        hookName: "before_prompt_build",
        handler: () => ({ prependSystemContext: prefix, appendSystemContext: suffix }),
      },
    ]),
  );
  let startedThreads = 0;
  let activeThreadId = "";
  let nativeInstructions = "";
  let effectiveInstructions = "";
  let relayInstructions = "";
  const nativeHistory = [
    { role: "user", content: "Synthetic native history remains byte-identical." },
  ];
  const harness = createStartedThreadHarness(
    async (method, request) => {
      if (method === "account/read") {
        return { account: { type: "apiKey" } };
      }
      if (method === "thread/start" || method === "thread/resume") {
        assert(isJsonObject(request));
        if (typeof request.developerInstructions === "string") {
          nativeInstructions = request.developerInstructions;
        }
        if (method === "thread/start") {
          activeThreadId = `thread-${++startedThreads}`;
        } else {
          assert(typeof request.threadId === "string");
          activeThreadId = request.threadId;
        }
        return threadStartResult(activeThreadId);
      }
      if (method === "turn/start") {
        assert(isJsonObject(request) && isJsonObject(request.responsesapiClientMetadata));
        const generation = request.responsesapiClientMetadata[CODEX_INFERENCE_GENERATION_KEY];
        assert(typeof generation === "string");
        const route = getCodexInferenceThread(harness.client, activeThreadId);
        assert(route, "The regression must exercise the actual managed inference route");
        const metadata = { requestKind: "turn", threadId: activeThreadId, generation };
        const nativeBody = { instructions: nativeInstructions, input: nativeHistory };
        const prepared = route.context.prepare(nativeBody, metadata);
        prepared.assertCurrent();
        assert(typeof prepared.body.instructions === "string");
        effectiveInstructions = prepared.body.instructions;
        const relay = route.context.prepare({ input: nativeHistory }, metadata);
        assert(typeof relay.body.instructions === "string");
        relayInstructions = relay.body.instructions;
      }
      return undefined;
    },
    { persistedThreads: [] },
  );
  ownCodexInferenceClient(harness.client);

  for (const [index, snapshot] of snapshots.entries()) {
    prefix = `Synthetic plugin prefix ${index}.`;
    suffix = `Synthetic plugin suffix ${index}.`;
    const params = createParams(path.join(tempDir, "session.jsonl"), workspaceDir, {
      runId: `relay-trajectory-${index}`,
    });
    params.runtimePlan = createCodexRuntimePlanFixture();
    params.skillsSnapshot = { prompt: skills, skills: [] };
    params.extraSystemPrompt = snapshot.conversation
      ? `${persistent}\n\n${snapshot.conversation}`
      : persistent;
    params.extraSystemPromptTurnContext = snapshot.conversation
      ? { start: persistent.length + 2, text: snapshot.conversation }
      : undefined;
    await setHostToolFactoryForTest(params, () => [createRuntimeDynamicTool(snapshot.tool)]);
    setCodexTestModelSupportsTools(params, true);
    await attachSqliteSessionTarget(
      params,
      path.join(tempDir, "sessions.sqlite"),
      params.sessionId,
    );
    const { agentId, sessionId, sessionKey, storePath } = params.sessionTarget ?? {};
    assert(agentId && sessionId && sessionKey && storePath);
    const target = { agentId, sessionId, sessionKey, storePath };
    const trajectoryRecorder = await createTrajectoryRuntimeRecorderForTest({
      ...target,
      sessionTarget: target,
      runId: params.runId,
      provider: params.provider,
      modelId: params.modelId,
      workspaceDir,
    });
    assert(trajectoryRecorder, "Expected the real SQLite trajectory recorder");
    const host = await createAgentHarnessHostCapabilitiesForTest({
      attempt: { ...params, trajectoryRecorder },
      pluginId: "codex",
      nativeModelPolicySupport: "exact",
    });
    params.hostCapabilities = host.capabilities;
    try {
      const offset = harness.requests.length;
      const run = runCodexAppServerAttempt(params);
      await run.waitForTurnAccepted();
      await harness.completeTurn({ threadId: activeThreadId, turnId: "turn-1" });
      expect(readAttemptTerminal(await run)).toMatchObject({
        aborted: false,
        timedOut: false,
        promptError: null,
      });
      await trajectoryRecorder.flush();
      const contexts = (await loadSqliteTrajectoryRuntimeEvents(target)).filter(
        (event) => event.runId === params.runId && event.type === "context.compiled",
      );
      expect(contexts).toHaveLength(1);
      const recorded = contexts[0]?.data?.systemPrompt;
      assert(typeof recorded === "string");
      const conversation =
        snapshot.conversation ?? "No additional conversation instructions for this turn.";
      const bindings = `Current OpenClaw tool bindings for this turn (accepted declarations alone do not grant execution): openclaw.${snapshot.tool}.`;
      for (const part of [persona, skills, prefix, suffix, conversation, bindings]) {
        expect(relayInstructions.split(part), `actual relay contains ${part} once`).toHaveLength(2);
        expect(recorded.split(part), `persisted trajectory contains ${part} once`).toHaveLength(2);
      }
      expect(recorded).toBe(effectiveInstructions);
      expect(recorded).toBe(`${nativeInstructions}\n\n${relayInstructions}`);
      expect(recorded.split(persistent)).toHaveLength(2);
      expect(nativeInstructions).toContain(persistent);
      for (const old of snapshots.slice(0, index)) {
        if (old.conversation) {
          expect(recorded).not.toContain(old.conversation);
          expect(relayInstructions).not.toContain(old.conversation);
        }
      }
      const nativeRequests = JSON.stringify(harness.requests.slice(offset));
      for (const part of [persona, skills, prefix, suffix, conversation, bindings]) {
        expect(nativeRequests).not.toContain(part);
      }
      if (index === 1) {
        // Conversation-only refresh must not mutate native history or persistent policy.
        expect(harness.requests.slice(offset).map(({ method }) => method)).not.toContain(
          "thread/start",
        );
        expect(harness.requests.slice(offset).map(({ method }) => method)).not.toContain(
          "thread/inject_items",
        );
      }
    } finally {
      host.close();
    }
  }
});
