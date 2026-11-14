import { describe, expect, it } from "vitest";
import { nativeToolResultContentSource } from "./event-projector-items.js";
import { readItem } from "./event-projector-values.js";
import type { JsonObject } from "./protocol.js";

describe("native tool result content source", () => {
  it.each<[JsonObject, "network" | undefined]>([
    [{ type: "webSearch", query: "query" }, "network"],
    [{ type: "webSearch", status: "blocked" }, undefined],
    [{ type: "webSearch", status: "failed" }, undefined],
    [
      { type: "webSearch", status: "failed", results: [{ url: "https://example.test" }] },
      "network",
    ],
    [
      {
        type: "mcpToolCall",
        status: "completed",
        result: { content: [{ type: "text", text: "result" }] },
      },
      "network",
    ],
    [
      {
        type: "mcpToolCall",
        status: "failed",
        result: { content: [{ type: "text", text: "remote error" }] },
      },
      "network",
    ],
    [
      {
        type: "mcpToolCall",
        status: "completed",
        result: { content: [], structuredContent: { data: 1 } },
      },
      "network",
    ],
    [
      {
        type: "mcpToolCall",
        status: "failed",
        result: null,
        error: { message: "approval denied" },
      },
      undefined,
    ],
    [
      {
        type: "mcpToolCall",
        status: "completed",
        result: { content: [], structuredContent: null, _meta: null },
      },
      undefined,
    ],
    [{ type: "commandExecution", status: "completed" }, undefined],
  ])("classifies %j as %s", (item, source) => {
    expect(nativeToolResultContentSource(readItem({ id: "native-item", ...item }))).toBe(source);
  });
});
