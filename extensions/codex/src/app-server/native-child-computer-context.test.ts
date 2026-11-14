import { createOpenClawCodingTools } from "openclaw/plugin-sdk/agent-harness";
import { resetGlobalHookRunner } from "openclaw/plugin-sdk/hook-runtime";
import {
  createEmptyPluginRegistry,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, expect, it, vi } from "vitest";
import type { CodexComputerContextEpoch } from "./computer-context.js";
import {
  createBridge,
  createDynamicToolCall,
  installResultMiddleware,
} from "./dynamic-tools.test-support.js";
import {
  createCodexTestHostCapabilities,
  setCodexTestToolFactory,
} from "./host-capability.test-support.js";
import { prepareCodexNativeChildToolFactory } from "./native-child-tools.js";

const FRAME =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
const REPLACEMENT =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=";

afterEach(() => {
  resetGlobalHookRunner();
  setActivePluginRegistry(createEmptyPluginRegistry());
  vi.restoreAllMocks();
});

it.each(["preserved", "replaced", "failed", "compacted"] as const)(
  "retains real child computer coordinate authority only for visible context (%s)",
  async (mode) =>
    withOpenClawTestState({ layout: "split", prefix: "native-child-computer-" }, async (state) => {
      const epoch: CodexComputerContextEpoch = { value: 0 };
      const cleanups: Array<(reason: string) => Promise<void>> = [];
      const invoke = vi.fn(async (request: { command: string }) =>
        request.command === "screen.snapshot"
          ? {
              format: "png",
              base64: FRAME,
              displayFrameId: "display-0-frame",
              width: 1280,
              height: 800,
              screenIndex: 0,
            }
          : { ok: true },
      );
      const computer = createOpenClawCodingTools({
        agentId: "main",
        sessionKey: "agent:main:computer-child",
        workspaceDir: state.workspaceDir,
        config: { tools: { allow: ["computer"] } },
        toolConstructionPlan: {
          includeBaseCodingTools: false,
          includeShellTools: false,
          includeChannelTools: false,
          includeOpenClawTools: true,
          includePluginTools: false,
        },
        computerContextEpoch: epoch,
        computerTransport: {
          resolveNode: async () => ({ nodeId: "test-desktop" }),
          invoke,
        },
        registerRunCleanup: (cleanup) => cleanups.push(cleanup),
      }).find((tool) => tool.name === "computer");
      expect(computer).toBeDefined();
      if (!computer) {
        throw new Error("Real computer tool was not assembled");
      }
      const frameIds = new Map<string, string>();
      const execute = computer.execute;
      vi.spyOn(computer, "execute").mockImplementation(async (...args) => {
        const result = await execute(...args);
        const details = result.details as { frameId?: string } | undefined;
        if (details?.frameId) {
          frameIds.set(args[0], details.frameId);
        }
        return result;
      });
      const childBase = createCodexTestHostCapabilities();
      setCodexTestToolFactory({ hostCapabilities: childBase }, () => [computer]);
      const childHost = {
        ...childBase,
        computerContextEpoch: epoch,
        observeToolOutcome: vi.fn(),
        createToolSurfaceAsync: () => childBase.createToolSurfaceAsync!({}),
      };
      const release = vi.fn();
      const parentHost = createCodexTestHostCapabilities({
        createDelegatedToolHost: async () => ({
          capabilities: childHost,
          close: async () => {
            await Promise.all(cleanups.map((cleanup) => cleanup("child-closed")));
          },
        }),
      });
      const factory = prepareCodexNativeChildToolFactory({
        policy: { allow: ["computer"] },
        hostCapabilities: parentHost,
        parentBridge: createBridge([computer]),
        registeredTools: [computer],
        executionPolicy: {
          policy: {
            nativeToolSurfaceAllowed: true,
            sandboxed: false,
            requestedExecHost: "auto",
            effectiveExecHost: "gateway",
          },
          assertCurrent: async () => {},
          admit: async (write) => write(),
          retain: () => release,
          release: () => {},
        },
        cwd: state.workspaceDir,
        hookContext: { sessionKey: "agent:main:computer-child", agentId: "main" },
        normalizeTools: (tools) => tools,
        materializeMcpTools: async () => ({ tools: [], dispose: async () => {} }),
      });
      const child = factory.createChildTools!({
        runId: "child",
        threadId: "thread-1",
        assertCurrent: () => {},
      });
      const call = (id: string, args: Record<string, string | number[]>) =>
        child.handleToolCall(
          createDynamicToolCall("computer", args, id),
          new AbortController().signal,
        );
      if (mode === "replaced" || mode === "failed") {
        installResultMiddleware(async (event) => {
          if (mode === "failed") {
            throw new Error("screenshot middleware failed");
          }
          return {
            result: {
              ...event.result,
              content: [{ type: "image", mimeType: "image/png", data: REPLACEMENT }],
            },
          };
        });
      }
      try {
        const screenshot = await call("shot", { action: "screenshot" });
        expect(screenshot.success).toBe(mode !== "failed");
        expect(frameIds.get("shot")).toEqual(expect.any(String));
        if (mode === "compacted") {
          child.observeContextCompaction("compact-1");
        }
        expect(epoch.value).toBe(mode === "preserved" ? 0 : 1);
        const clicked = await call("click", {
          action: "left_click",
          coordinate: [1, 2],
          frameId: frameIds.get("shot")!,
        });
        expect(clicked.success).toBe(mode === "preserved");
        expect(
          invoke.mock.calls.filter(([request]) => request.command === "computer.act"),
        ).toHaveLength(mode === "preserved" ? 1 : 0);
        if (mode === "compacted") {
          expect((await call("fresh-shot", { action: "screenshot" })).success).toBe(true);
          expect(epoch.frameToolCallId).toBe("fresh-shot");
          child.observeContextCompaction("compact-1");
          expect(epoch.frameToolCallId).toBe("fresh-shot");
          child.observeContextCompaction("compact-2");
          expect(epoch).toEqual({ value: 2 });
        }
      } finally {
        child.dispose();
        await vi.waitFor(() => expect(release).toHaveBeenCalledOnce());
      }
    }),
);
