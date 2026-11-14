import { describe, expect, it } from "vitest";
import { readCodexPluginConfig } from "./config.js";
import { inspectCodexNativeChildTools } from "./native-child-tool-policy.js";

const tools = [
  { name: "read_note", pluginId: "memory" },
  { name: "better_patch", pluginId: "patch" },
  { name: "research__get_item", pluginId: "bundle-mcp", mcpServerName: "research" },
  { name: "research__delete_item", pluginId: "bundle-mcp", mcpServerName: "research" },
  { name: "message" },
];
const allowed = (policy: Parameters<typeof inspectCodexNativeChildTools>[0]) =>
  inspectCodexNativeChildTools(policy, tools)
    .tools.filter((tool) => tool.status === "allowed")
    .map((tool) => tool.name);

describe("native child host tool policy", () => {
  it.each([undefined, {}, { allow: [] }, { allow: [" "] }])(
    "defaults to no grants: %j",
    (policy) => {
      expect(allowed(policy)).toEqual([]);
    },
  );

  it("matches complete canonical names, normalizes patterns and gives deny precedence", () => {
    expect(
      allowed({ allow: [" READ_NOTE ", "research__*"], deny: ["research__delete_*"] }),
    ).toEqual(["read_note", "research__get_item"]);
    expect(allowed({ allow: ["research__get_*"] })).toEqual(["research__get_item"]);
    expect(allowed({ allow: ["research", "memory", "openclaw__read_note"] })).toEqual([]);
  });

  it("cannot restore unavailable tools or grant source-bound controls with a wildcard", () => {
    const report = inspectCodexNativeChildTools({ allow: ["*"] }, tools.slice(1), tools);
    expect(report.tools.find((tool) => tool.name === "read_note")?.status).toBe("unavailable");
    expect(report.tools.find((tool) => tool.name === "message")?.status).toBe("unsupported");
    expect(report.tools.find((tool) => tool.name === "better_patch")?.status).toBe("allowed");
  });

  it("explains foreground-bound personal authoring without excluding ordinary skills", () => {
    const report = inspectCodexNativeChildTools({ allow: ["*"] }, [
      { name: "skill_library" },
      { name: "skills_read" },
    ]);
    expect(report.tools.find((tool) => tool.name === "skill_library")).toMatchObject({
      status: "unsupported",
      unsupportedReason: expect.stringContaining("foreground"),
    });
    expect(report.tools.find((tool) => tool.name === "skills_read")?.status).toBe("allowed");
  });

  it("includes newly available matches and reports owner identities and unmatched patterns", () => {
    const added = [...tools, { name: "research__get_new", mcpServerName: "research" }];
    const report = inspectCodexNativeChildTools(
      { allow: ["research__get_*", "missing_*"], deny: ["absent"] },
      added,
    );
    expect(report.tools.find((tool) => tool.name === "research__get_new")).toEqual({
      name: "research__get_new",
      mcpServerName: "research",
      status: "allowed",
    });
    expect(report.unmatchedAllow).toEqual(["missing_*"]);
    expect(report.unmatchedDeny).toEqual(["absent"]);
  });

  it("parses the opt-in without changing parent exclusions or runtime policy", () => {
    expect(
      readCodexPluginConfig({
        nativeChildTools: { allow: [" read_note "], deny: ["research__delete_*"] },
      }),
    ).toMatchObject({ nativeChildTools: { allow: ["read_note"], deny: ["research__delete_*"] } });
    expect(() => readCodexPluginConfig({ nativeChildTools: { allow: [" "] } })).toThrow();
    expect(() =>
      readCodexPluginConfig({
        nativeChildTools: { allow: ["read_note"] },
        appServer: { mode: "invalid" },
      }),
    ).toThrow("Invalid Codex plugin configuration");
  });
});
