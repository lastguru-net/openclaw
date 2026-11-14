import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { bundledPluginFileAt } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it } from "vitest";
import type { EventFrame } from "../../packages/gateway-protocol/src/index.js";
import { withCodexNativeThreadReader } from "../../test/helpers/gateway-codex-harness-native-subagent.js";
import {
  createCodexHarnessLiveInstance,
  stageCodexHarnessLiveAuth,
  createCodexHarnessWorkspace,
  extractChatFinalText,
} from "../../test/helpers/gateway-codex-harness.js";
import {
  closeHttpServer,
  listenLoopback,
} from "../../test/helpers/gateway-integration-fixtures.js";
import { createNativeChildProofMcpServer } from "../../test/helpers/native-child-host-tools-mcp.js";
import { resolveAgentDir } from "../agents/agent-scope-config.js";
import { isLiveTestEnabled } from "../agents/live-test-helpers.js";
import { requesterMcpOAuthIdentity } from "../agents/mcp-oauth-identity.js";
import { seedMcpOAuthStoreForTest } from "../agents/mcp-oauth.test-support.js";
import type { OpenClawConfig } from "../config/config.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { GATEWAY_CLIENT_NAMES, INTERNAL_MESSAGE_CHANNEL } from "../utils/message-channel.js";
import type { GatewayClient } from "./client.js";
import {
  connectTestGatewayClient,
  ensurePairedTestGatewayClientIdentity,
} from "./gateway-cli-backend.live-helpers.js";
import { buildCodexHarnessAppServerArgs } from "./gateway-codex-harness.live-helpers.js";
import { liveOpenAiApiKeyModels } from "./live-openai-models.test-support.js";

const enabled = isLiveTestEnabled() && process.env.OPENCLAW_LIVE_CODEX_NATIVE_CHILD_TOOLS === "1";
const timeout = 300_000;
const names = [
  "fixture_memory_read",
  "fixture_wait_release",
  "fixture_forbidden_read",
  "fixture_unlisted_read",
];
type Receipt = {
  runId: string;
  toolCallId: string;
  tool: string;
  at: number;
  value?: string;
  requester?: { channel?: string; senderId?: string; accountId?: string };
};
const records = (items: unknown) =>
  Array.isArray(items)
    ? items.flatMap((item) => {
        const value = asOptionalRecord(item);
        return value ? [value] : [];
      })
    : [];
const threadItems = (thread: Record<string, unknown>) =>
  records(thread.turns).flatMap((turn) => records(turn.items));

describe.skipIf(!enabled)("native Codex child host tools, real Gateway/provider", () => {
  it("reads fresh plugin and requester-projected MCP data after its parent ends; deny has no child effect", async () => {
    const model = process.env.OPENCLAW_LIVE_CODEX_HARNESS_MODEL?.trim();
    if (!model) {
      throw new Error("Set OPENCLAW_LIVE_CODEX_HARNESS_MODEL to the authorized native Codex model");
    }
    const auth =
      process.env.OPENCLAW_LIVE_CODEX_HARNESS_AUTH === "api-key" ? "api-key" : "codex-auth";
    if (auth === "api-key" && !process.env.OPENAI_API_KEY?.trim()) {
      throw new Error("API-key mode requires OPENAI_API_KEY");
    }
    const token = `synthetic-${randomUUID()}`;
    const nonce = randomUUID();
    const instance = await createCodexHarnessLiveInstance(token, auth);
    const root = instance.state.path("native-child-proof");
    const plugin = instance.state.path("native-child-proof-plugin");
    const events: EventFrame[] = [];
    let client: GatewayClient | undefined;
    const read = async <T>(name: string): Promise<T> =>
      JSON.parse(await fs.readFile(path.join(root, name), "utf8"));
    const write = (name: string, value: unknown) =>
      fs.writeFile(path.join(root, name), JSON.stringify(value));
    const server = createNativeChildProofMcpServer(root, nonce);
    try {
      const staged = auth === "codex-auth" ? await stageCodexHarnessLiveAuth(instance) : undefined;
      const agentId = staged?.agentId ?? "dev";
      instance.state.applyEnv();
      const nativeHome = instance.state.path("native-child-user-home");
      await fs.mkdir(nativeHome, { recursive: true });
      instance.env.HOME = nativeHome;
      instance.env.USERPROFILE = nativeHome;
      await fs.mkdir(root, { recursive: true });
      await fs.mkdir(plugin, { recursive: true });
      await createCodexHarnessWorkspace(instance.state.workspaceDir);
      await write("data.json", { memory: randomUUID(), mcp: randomUUID() });
      await fs.copyFile(
        path.resolve(import.meta.dirname, "../../test/fixtures/native-child-host-tools/plugin.cjs"),
        path.join(plugin, "index.cjs"),
      );
      await fs.writeFile(
        path.join(plugin, "package.json"),
        JSON.stringify({
          name: "native-child-proof",
          version: "1.0.0",
          main: "index.cjs",
          openclaw: { extensions: ["./index.cjs"] },
        }),
      );
      await fs.writeFile(
        path.join(plugin, "openclaw.plugin.json"),
        JSON.stringify({
          id: "native-child-proof",
          name: "Synthetic child proof",
          contracts: { tools: names },
          configSchema: {
            type: "object",
            properties: { root: { type: "string" }, nonce: { type: "string" } },
            required: ["root", "nonce"],
            additionalProperties: false,
          },
        }),
      );
      const mcpUrl = `${await listenLoopback(server)}/mcp`;
      const identity = requesterMcpOAuthIdentity("proof_mcp", mcpUrl, {
        requesterSenderId: GATEWAY_CLIENT_NAMES.TEST,
        messageChannel: INTERNAL_MESSAGE_CHANNEL,
      });
      // Canonical fixture state, before the Gateway producer starts; never mutate its DB concurrently.
      seedMcpOAuthStoreForTest(identity.storeKey, {
        tokens: { access_token: nonce, token_type: "Bearer" },
        tokenExpiresAt: Date.now() + 3_600_000,
      });
      await closeOpenClawStateDatabaseAsync();
      const cfg: OpenClawConfig = {
        gateway: {
          mode: "local",
          port: instance.port,
          auth: { mode: "token", token },
          controlUi: { enabled: false },
        },
        tools: { deny: ["message", "automations", "gateway"] },
        mcp: {
          servers: {
            proof_mcp: {
              url: mcpUrl,
              transport: "streamable-http",
              auth: "oauth",
              oauth: { identity: "per-requester" },
              codex: { defaultToolsApprovalMode: "auto" },
            },
          },
        },
        plugins: {
          allow: ["codex", "native-child-proof"],
          load: { paths: [plugin] },
          slots: { memory: "none" },
          entries: {
            "native-child-proof": { enabled: true, config: { root, nonce } },
            codex: {
              enabled: true,
              config: {
                nativeChildTools: {
                  allow: [
                    "fixture_memory_read",
                    "fixture_wait_release",
                    "proof_mcp__*",
                    "fixture_forbidden_read",
                  ],
                  deny: ["fixture_forbidden_*"],
                },
                codexDynamicToolsExclude: [
                  "exec",
                  "process",
                  "read",
                  "write",
                  "edit",
                  "apply_patch",
                ],
                appServer: {
                  mode: "guardian",
                  approvalPolicy: "never",
                  sandbox: "read-only",
                  args: buildCodexHarnessAppServerArgs([]),
                },
              },
            },
          },
        },
        ...(staged?.auth ? { auth: staged.auth } : {}),
        agents: {
          defaults: {
            workspace: instance.state.workspaceDir,
            skipBootstrap: true,
            timeoutSeconds: 290,
            maxConcurrent: 4,
            thinkingDefault: "low",
            sandbox: { mode: "off" },
            model: { primary: model },
            models: { [model]: { agentRuntime: { id: "codex" } } },
          },
          entries: {
            [agentId]: {
              workspace: instance.state.workspaceDir,
              model: { primary: model },
              models: { [model]: { agentRuntime: { id: "codex" } } },
            },
          },
        },
        ...(auth === "api-key"
          ? {
              secrets: { providers: { default: { source: "env" } } },
              models: liveOpenAiApiKeyModels(),
            }
          : {}),
      };
      await fs.writeFile(instance.configPath, JSON.stringify(cfg));
      const deviceIdentity = await ensurePairedTestGatewayClientIdentity({
        displayName: "native-child-proof",
      });
      await instance.startGateway();
      client = await connectTestGatewayClient({
        url: instance.url,
        token,
        deviceIdentity,
        requestTimeoutMs: timeout,
        onEvent: (event) => events.push(event),
      });
      const runId = randomUUID();
      const sessionKey = `agent:${agentId}:native-child-proof`;
      const args = JSON.stringify({ phase: "parent", nonce });
      const childTask = [
        `Synthetic local integration proof. Call fixture_wait_release with ${JSON.stringify({ phase: "child", nonce })} FIRST and await its result.`,
        `Then make NEW calls to fixture_memory_read and proof_mcp__read, each with ${JSON.stringify({ phase: "child", nonce })}.`,
        "Then call fixture_forbidden_read and fixture_unlisted_read once each with those same arguments; both expected denials are negative controls (wildcard deny and default deny). Do not use shell, files, network, other tools or other agents.",
        "Finally reply exactly CHILD-OK:<memory tool value>:<MCP tool value>:DENIED using the returned values. Do not guess any value.",
      ].join("\n");
      const started = await client.request<{ status: string }>("chat.send", {
        sessionKey,
        idempotencyKey: runId,
        message: [
          `Synthetic local integration proof. First call fixture_memory_read, proof_mcp__read, fixture_forbidden_read and fixture_unlisted_read once each with ${args}; all four must succeed.`,
          `Then use native spawn_agent (NOT sessions_spawn) exactly once, with this exact task:\n${childTask}`,
          "Do not wait for the child or close it. Its first tool intentionally waits for the test owner. Immediately finish your own turn with exactly PARENT-DONE.",
          "Do not call shell, files, network or other tools.",
        ].join("\n"),
      });
      expect(started.status).toBe("started");
      await expect
        .poll(() => events.map((event) => extractChatFinalText(event, runId)).find(Boolean), {
          timeout,
          interval: 100,
        })
        .toBe("PARENT-DONE");
      expect(
        await client.request(
          "agent.wait",
          { runId, timeoutMs: timeout },
          { timeoutMs: timeout + 5000 },
        ),
      ).toMatchObject({ status: "ok" });
      // Positive control must pass on the exact parent execution, including deny-list tool.
      for (const name of [
        "fixture_memory_read",
        "proof_mcp__read",
        "fixture_forbidden_read",
        "fixture_unlisted_read",
      ]) {
        const receipt = await read<Receipt>(`effect-parent-${name}.json`);
        expect(receipt.runId).toBe(runId);
        expect(receipt.requester).toMatchObject({
          channel: INTERNAL_MESSAGE_CHANNEL,
          senderId: GATEWAY_CLIENT_NAMES.TEST,
        });
      }
      await expect
        .poll(() => read<Receipt>("waiting.json").catch(() => undefined), {
          timeout,
          interval: 100,
        })
        .toBeDefined();
      const completedAt = Date.now();
      const fresh = { memory: randomUUID(), mcp: randomUUID() };
      await write("data.json", fresh); // Values did not exist before foreground admission closed.
      await fs.writeFile(path.join(root, "release"), "release");
      const pkg = bundledPluginFileAt(
        path.resolve(import.meta.dirname, "../.."),
        "codex",
        "package.json",
      );
      const command = createRequire(pkg).resolve("@openai/codex/bin/codex.js");
      const parentEvent = events
        .flatMap((event) => (event.event === "agent" ? [asOptionalRecord(event.payload)] : []))
        .find(
          (event) =>
            event?.runId === runId &&
            event.stream === "codex_app_server.lifecycle" &&
            asOptionalRecord(event.data)?.phase === "thread_ready",
        );
      const nativeThreadId = asOptionalRecord(parentEvent?.data)?.threadId;
      const parentThreadId = typeof nativeThreadId === "string" ? nativeThreadId : "";
      expect(parentThreadId).not.toBe("");
      await withCodexNativeThreadReader(
        {
          command: process.execPath,
          args: [command, ...buildCodexHarnessAppServerArgs([])],
          codexHome: path.join(resolveAgentDir(cfg, agentId, instance.env), "codex-home"),
          stateDir: instance.stateDir,
          cwd: instance.state.workspaceDir,
          env: instance.env,
          requestTimeoutMs: timeout,
        },
        async (readNativeThread) => {
          const parent = asOptionalRecord(
            asOptionalRecord(await readNativeThread(parentThreadId))?.thread,
          )!;
          const spawn = threadItems(parent).find(
            (item) => item.type === "collabAgentToolCall" && item.tool === "spawnAgent",
          );
          expect(threadItems(parent).some((item) => item.type === "commandExecution")).toBe(false);
          expect(spawn).toBeDefined();
          expect(spawn?.receiverThreadIds).toHaveLength(1);
          const childId = String((spawn!.receiverThreadIds as string[])[0]);
          let child: Record<string, unknown> = {};
          const expected = `CHILD-OK:${fresh.memory}:${fresh.mcp}:DENIED`;
          await expect
            .poll(
              async () => {
                child = asOptionalRecord(
                  asOptionalRecord(await readNativeThread(childId))?.thread,
                )!;
                return threadItems(child).some(
                  (item) => item.type === "agentMessage" && item.text === expected,
                );
              },
              { timeout, interval: 1000 },
            )
            .toBe(true);
          expect(child.parentThreadId).toBe(parentThreadId);
          const items = threadItems(child);
          expect(items.some((item) => item.type === "commandExecution")).toBe(false);
          const waiting = await read<Receipt>("waiting.json");
          expect(waiting.runId).not.toBe(runId);
          expect(waiting.runId).toContain(childId);
          for (const [name, value] of [
            ["fixture_memory_read", fresh.memory],
            ["proof_mcp__read", fresh.mcp],
          ]) {
            const receipt = await read<Receipt>(`effect-child-${name}.json`);
            expect(receipt).toMatchObject({ runId: waiting.runId, value });
            expect(receipt.at).toBeGreaterThanOrEqual(completedAt);
            expect(receipt.requester).toMatchObject({
              channel: INTERNAL_MESSAGE_CHANNEL,
              senderId: GATEWAY_CLIENT_NAMES.TEST,
            });
            expect(items).toContainEqual(
              expect.objectContaining({
                type: "dynamicToolCall",
                tool: name,
                id: receipt.toolCallId,
                success: true,
              }),
            );
          }
          for (const name of ["fixture_forbidden_read", "fixture_unlisted_read"]) {
            expect(items).toContainEqual(
              expect.objectContaining({ type: "dynamicToolCall", tool: name, success: false }),
            );
            await expect(fs.access(path.join(root, `effect-child-${name}.json`))).rejects.toThrow();
            await expect(fs.access(path.join(root, `gate-child-${name}.json`))).rejects.toThrow();
          }
        },
      );
    } finally {
      await fs.writeFile(path.join(root, "release"), "cleanup").catch(() => undefined);
      try {
        await client?.stopAndWait();
      } finally {
        try {
          if (server.listening) {
            await closeHttpServer(server);
          }
        } finally {
          await instance.cleanup();
        }
      }
    }
  }, 900_000);
});
