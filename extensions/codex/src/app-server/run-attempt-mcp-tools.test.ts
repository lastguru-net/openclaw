import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { createPluginMetadataSnapshotFixture } from "openclaw/plugin-sdk/plugin-test-runtime";
import { withServer } from "openclaw/plugin-sdk/test-env";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { expect, it } from "vitest";
import { createCodexTestHostCapabilities } from "./host-capability.test-support.js";
import { createCodexOwnedMcpMaterializer } from "./run-attempt-mcp-tools.js";

it("checks the child owner's taint before shared MCP sign-in", async (context) => {
  if (!context.codexAttemptRuntime) {
    throw new Error("Shared Codex MCP runtime fixture required");
  }
  const runtime = context.codexAttemptRuntime;
  await withOpenClawTestState({ prefix: "codex-child-mcp-taint-" }, async (state) => {
    let requests = 0;
    await withServer(
      (request, response) => {
        requests += 1;
        request.resume();
        response.writeHead(401).end();
      },
      async (url) => {
        const cfg: OpenClawConfig = {
          mcp: {
            servers: {
              calendar: {
                url: `${url}/mcp`,
                transport: "streamable-http",
                auth: "oauth",
              },
            },
          },
        };
        const parentTaint = () => false;
        const configured = {
          workspaceDir: state.workspaceDir,
          sessionId: "child-mcp-taint",
          cfg,
          metadata: createPluginMetadataSnapshotFixture(),
          policyContext: { senderIsOwner: true, chatType: "direct" },
          reservedToolNames: [],
          // Model a contaminated construction recipe. Per-owner state must override it.
          isTurnTainted: parentTaint,
        };
        const materialize = createCodexOwnedMcpMaterializer({
          configured,
          interactiveConfiguredApproval: false,
        });
        const hostCapabilities = createCodexTestHostCapabilities();
        const disposers: Array<() => Promise<void>> = [];
        const toolsFor = async (runId: string, isTurnTainted: () => boolean) => {
          const view = await materialize({ runId, hostCapabilities, isTurnTainted });
          if (!view.configured) {
            throw new Error("Configured MCP view missing");
          }
          disposers.push(view.configured.dispose);
          return view.configured.tools;
        };

        await runtime.start();
        try {
          const parentTools = await toolsFor("parent", parentTaint);
          expect(parentTools.map((tool) => tool.name)).toContain("calendar__connect");

          let childTainted = false;
          const childTools = await toolsFor("child", () => childTainted);
          const connect = childTools.find((tool) => tool.name === "calendar__connect");
          if (!connect) {
            throw new Error("Clean child shared sign-in tool missing");
          }
          childTainted = true;
          const before = requests;
          await expect(connect.execute("blocked", {})).rejects.toThrow(
            "Shared MCP sign-in requires an untainted owner turn",
          );
          expect(requests).toBe(before);
          expect(parentTaint()).toBe(false);

          const taintedTools = await toolsFor("already-tainted-child", () => true);
          expect(taintedTools.map((tool) => tool.name)).not.toContain("calendar__connect");
        } finally {
          try {
            await Promise.all(disposers.map((dispose) => dispose()));
          } finally {
            await runtime.stop();
          }
        }
      },
    );
  });
});
