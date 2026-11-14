import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { text } from "node:stream/consumers";

/** Synthetic local MCP owner. Never authenticates to a real server or reads user data. */
export function createNativeChildProofMcpServer(root: string, nonce: string) {
  const read = async <T>(name: string): Promise<T> =>
    JSON.parse(await fs.readFile(path.join(root, name), "utf8"));
  const write = (name: string, value: unknown) =>
    fs.writeFile(path.join(root, name), JSON.stringify(value));
  const schema = {
    type: "object",
    properties: { nonce: { type: "string" }, phase: { enum: ["parent", "child"] } },
    required: ["nonce", "phase"],
    additionalProperties: false,
  };
  // Real configured HTTP MCP. Its effect requires OpenClaw's before-tool hook,
  // so direct native MCP execution cannot accidentally satisfy this proof.
  return createServer((req, res) => {
    void (async () => {
      if (req.url !== "/mcp" || req.headers.authorization !== `Bearer ${nonce}`) {
        res.writeHead(403).end();
        return;
      }
      if (req.method !== "POST") {
        res.writeHead(405).end();
        return;
      }
      const message = JSON.parse(await text(req));
      if (message.id === undefined) {
        res.writeHead(202).end();
        return;
      }
      let result: unknown;
      if (message.method === "initialize") {
        result = {
          protocolVersion: message.params.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: "synthetic-proof", version: "1.0.0" },
        };
      } else if (message.method === "tools/list") {
        result = {
          tools: [
            { name: "read", description: "Read synthetic proof data only", inputSchema: schema },
          ],
        };
      } else if (message.method === "tools/call" && message.params.name === "read") {
        const args = message.params.arguments;
        if (args.nonce !== nonce || !["parent", "child"].includes(args.phase)) {
          throw new Error("Invalid MCP input");
        }
        const gate = await read<{ runId: string; toolCallId: string }>(
          `gate-${args.phase}-proof_mcp__read.json`,
        );
        if (!gate.runId || !gate.toolCallId) {
          throw new Error("MCP effect has no host gate receipt");
        }
        const value = (await read<{ mcp: string }>("data.json")).mcp;
        await write(`effect-${args.phase}-proof_mcp__read.json`, {
          ...gate,
          at: Date.now(),
          value,
        });
        result = { content: [{ type: "text", text: value }] };
      } else {
        throw new Error("Unexpected MCP request");
      }
      res
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    })().catch(() => {
      if (!res.headersSent) {
        res.writeHead(500).end();
      } else {
        res.end();
      }
    });
  });
}
