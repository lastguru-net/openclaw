const fs = require("node:fs/promises");
const { watch } = require("node:fs");
const path = require("node:path");

module.exports = {
  id: "native-child-proof",
  name: "Synthetic native child host tools proof",
  register(api) {
    const { root, nonce } = api.pluginConfig;
    const file = (name) => path.join(root, name);
    const read = async (name) => JSON.parse(await fs.readFile(file(name), "utf8"));
    const write = (name, value) => fs.writeFile(file(name), JSON.stringify(value));
    const validate = (args) => {
      if (args?.nonce !== nonce || !["parent", "child"].includes(args.phase)) {
        throw new Error("Invalid synthetic proof input");
      }
    };
    const tools = [
      "fixture_memory_read",
      "fixture_wait_release",
      "fixture_forbidden_read",
      "fixture_unlisted_read",
    ];
    const schema = {
      type: "object",
      properties: { nonce: { type: "string" }, phase: { enum: ["parent", "child"] } },
      required: ["nonce", "phase"],
      additionalProperties: false,
    };
    api.on("before_tool_call", async (event, ctx) => {
      if (![...tools, "proof_mcp__read"].includes(event.toolName)) {
        return;
      }
      validate(event.params);
      if (!ctx.runId || !ctx.toolCallId) {
        throw new Error("Missing trusted host identity");
      }
      await write(`gate-${event.params.phase}-${event.toolName}.json`, {
        runId: ctx.runId,
        toolCallId: ctx.toolCallId,
        requester: ctx.requester,
        sessionKey: ctx.sessionKey,
        tool: event.toolName,
        at: Date.now(),
      });
    });
    api.registerTool(
      (ctx) =>
        tools.map((name) => ({
          name,
          label: name,
          description: "Synthetic local proof tool; no real user data or external effects.",
          parameters: schema,
          async execute(callId, args, signal) {
            validate(args);
            const gate = await read(`gate-${args.phase}-${name}.json`);
            if (gate.runId !== ctx.runId || gate.toolCallId !== callId) {
              throw new Error("Tool effect requires its exact host gate receipt");
            }
            if (name === "fixture_wait_release") {
              if (args.phase !== "child") {
                throw new Error("Only the native child may wait");
              }
              await write("waiting.json", gate);
              await new Promise((resolve, reject) => {
                const finish = (error) => {
                  watcher?.close();
                  signal?.removeEventListener("abort", abort);
                  if (error) {
                    reject(
                      error instanceof Error
                        ? error
                        : new Error("Child wait failed", { cause: error }),
                    );
                  } else {
                    resolve();
                  }
                };
                const abort = () => finish(signal.reason ?? new Error("Child aborted"));
                const check = () =>
                  fs.access(file("release")).then(
                    () => finish(),
                    () => {},
                  );
                const watcher = watch(root, () => void check());
                signal?.addEventListener("abort", abort, { once: true });
                if (signal?.aborted) {
                  abort();
                } else {
                  void check();
                }
              });
            }
            const value = (await read("data.json")).memory;
            await write(`effect-${args.phase}-${name}.json`, { ...gate, at: Date.now(), value });
            return { content: [{ type: "text", text: value }] };
          },
        })),
      { names: tools },
    );
  },
};
