import { AsyncResource } from "node:async_hooks";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, vi } from "vitest";
import {
  readOperatorToolGatewayAuthority,
  runWithOperatorToolGatewayAuthority,
} from "../../gateway/operator-tool-gateway-authority.js";
import * as gatewayMethods from "../../gateway/server-methods.js";
import { createOperatorClient } from "../../gateway/server-plugin-in-process-dispatch.test-support.js";
import { dispatchTrustedPluginGatewayMethod } from "../../gateway/server-plugins.js";
import { resetAgentRunRegistryForTest } from "../../infra/agent-run-registry.js";
import {
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeGatewayRequestScope,
  withPluginRuntimePluginScope,
} from "../../plugins/runtime/gateway-request-scope.js";
import { createAdmittedRunOperatorAuthority } from "../admitted-run-context.js";
import * as agentTools from "../agent-tools.async.js";
import { createAgentPluginRuntimeRefresh } from "../plugin-runtime-refresh.js";
import { getGatewayToolCallerIdentity } from "../tools/gateway-caller-context.js";
import { testTool } from "./host-capability.shard.test-support.js";
import { createAdmittedHostCapabilityTestFixture } from "./host-capability.test-support.js";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup();
  }
  vi.restoreAllMocks();
  resetAgentRunRegistryForTest();
});

it.each(["request", "operator-tool"] as const)(
  "runs child construction and plugin Gateway calls after the transport's %s scope expires",
  async (expiredScope) => {
    let revoked = false;
    const originalOperator = createAdmittedRunOperatorAuthority({
      profileId: "original-person",
      scopes: ["operator.write"],
      assertCurrent: () => {
        if (revoked) {
          throw new Error("original operator revoked");
        }
      },
    });
    const parent = await createAdmittedHostCapabilityTestFixture(
      {
        runId: "foreground",
        agentId: "main",
        sessionId: "physical-session",
        sessionKey: "agent:main:original",
        config: { tools: { profile: "coding" } },
        requesterOrigin: { sessionKey: "agent:main:original", senderId: "original-sender" },
      },
      { gatewayContext: true, operatorAuthority: originalOperator },
    );
    cleanups.push(parent.closeGateway, parent.closeAdmission, parent.closeHost);
    const oldRequest = new AbortController();
    const oldInvocation = new AbortController();
    const dispatch = vi
      .spyOn(gatewayMethods, "handleGatewayRequest")
      .mockImplementation(async (request) => {
        // Only the final transport is stubbed. The real trusted-plugin helper,
        // source selection, cancellation composition and in-process dispatch ran.
        expect(request.req.method).toBe("node.list");
        expect(request.signal?.aborted).toBe(false);
        expect(request.hasCurrentClientAuthority).toBeUndefined();
        expect(request.client?.connect.scopes).toEqual(["operator.read"]);
        expect(request.client?.internal?.operatorRunAuthority?.profileId).toBe("original-person");
        request.client?.internal?.operatorRunAuthority?.assertCurrent();
        const caller = expectDefined(getGatewayToolCallerIdentity(), "child caller");
        expect(caller.operationalRunInstance?.runId).toBe("child");
        expect(caller.requesterOrigin?.senderId).toBe("original-sender");
        expect(caller.operatorAuthority?.profileId).toBe("original-person");
        expect(readOperatorToolGatewayAuthority()).toBeUndefined();
        expect(getPluginRuntimeGatewayRequestScope()?.signal).toBeUndefined();
        request.respond(true, { nodes: [] });
      });
    const requestNodes = () =>
      withPluginRuntimePluginScope({ pluginId: "fixture", pluginOrigin: "bundled" }, () =>
        dispatchTrustedPluginGatewayMethod(
          "node.list",
          {},
          {
            signal: new AbortController().signal,
            scopes: ["operator.read"],
          },
        ),
      );
    const { tool } = testTool(
      vi.fn(async () => {
        await requestNodes();
        return { content: [], details: {} };
      }),
    );
    vi.spyOn(agentTools, "createOpenClawCodingToolsInternalAsync").mockImplementation(
      async (options) => {
        if (options?.runId === "child") {
          await requestNodes();
        }
        return [tool];
      },
    );
    parent.hostCapabilities.prepareDelegatedToolHosts!();
    await parent.hostCapabilities.createToolSurfaceAsync!({ config: parent.attempt.config });
    const retained = await parent.runWithGatewayScope(() =>
      withPluginRuntimeGatewayRequestScope(
        {
          ...getPluginRuntimeGatewayRequestScope(),
          isWebchatConnect: () => false,
          client: createOperatorClient({
            profileId: "original-person",
            scopes: ["operator.write"],
          }),
          ...(expiredScope === "request"
            ? {
                signal: oldRequest.signal,
                hasCurrentClientAuthority: () => !oldRequest.signal.aborted,
              }
            : {}),
        },
        () =>
          runWithOperatorToolGatewayAuthority(
            {
              scopes: ["operator.write"],
              signal: oldInvocation.signal,
              operatorRunAuthority: originalOperator,
            },
            async () => {
              const child = await parent.hostCapabilities.createDelegatedToolHost!({
                runId: "child",
              });
              cleanups.push(child.close);
              const projected = expectDefined(
                child.capabilities.bindToolSurface([tool])[0],
                "projected tool",
              );
              return {
                constructAndExecute: AsyncResource.bind(async () => {
                  const constructed = expectDefined(
                    (await child.capabilities.createToolSurfaceAsync())[0],
                    "constructed tool",
                  );
                  return await constructed.execute("constructed", {});
                }),
                executeProjected: AsyncResource.bind(() => projected.execute("projected", {})),
              };
            },
          ),
      ),
    );
    parent.closeHost();
    parent.closeAdmission();
    if (expiredScope === "request") {
      oldRequest.abort(new Error("old transport request ended"));
    } else {
      oldInvocation.abort(new Error("old operator tool ended"));
    }
    await expect(retained.constructAndExecute()).resolves.toMatchObject({ content: [] });
    await expect(retained.executeProjected()).resolves.toMatchObject({ content: [] });
    expect(dispatch).toHaveBeenCalledTimes(3);
    revoked = true;
    await expect(retained.executeProjected()).rejects.toThrow();
    expect(dispatch).toHaveBeenCalledTimes(3);
  },
);

it("does not capture the foreground refresh lifetime when constructing or binding child tools", async () => {
  const parent = await createAdmittedHostCapabilityTestFixture({
    runId: "foreground",
    agentId: "main",
    sessionKey: "agent:main:original",
    config: { tools: { profile: "coding" } },
  });
  cleanups.push(parent.closeAdmission, parent.closeHost);
  const { tool, execute } = testTool();
  vi.spyOn(agentTools, "createOpenClawCodingToolsInternalAsync").mockResolvedValue([tool]);
  const refresh = createAgentPluginRuntimeRefresh();
  cleanups.push(refresh.close);
  const child = await refresh.run(async () => {
    parent.hostCapabilities.prepareDelegatedToolHosts!();
    await parent.hostCapabilities.createToolSurfaceAsync!({ config: parent.attempt.config });
    const owner = await parent.hostCapabilities.createDelegatedToolHost!({ runId: "child" });
    cleanups.push(owner.close);
    return {
      owner,
      constructed: expectDefined(
        (await owner.capabilities.createToolSurfaceAsync())[0],
        "child tool",
      ),
      projected: expectDefined(owner.capabilities.bindToolSurface([tool])[0], "projected tool"),
    };
  });
  parent.closeHost();
  parent.closeAdmission();
  refresh.close();
  await child.constructed.execute("constructed-after-parent", {});
  await child.projected.execute("projected-after-parent", {});
  expect(execute).toHaveBeenCalledTimes(2);
  await child.owner.close();
  await expect(child.projected.execute("after-child", {})).rejects.toThrow();
  expect(execute).toHaveBeenCalledTimes(2);
});
