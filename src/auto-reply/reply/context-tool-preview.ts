import type { SessionSystemPromptReport } from "../../config/sessions/session-system-prompt-report.js";
import { formatFencedCodeBlock } from "../../shared/markdown-code.js";
import { matchesStarSegments } from "../../shared/star-pattern.js";
import { sanitizeChatDisplayText } from "../../shared/text/chat-display.js";

const USAGE = "Usage: /context tools [--allow PATTERN]... [--deny PATTERN]...";

function nameMatcher(pattern: string) {
  const normalized = pattern.toLowerCase();
  const parts = normalized.split("*");
  if (parts.length === 1) {
    return (name: string) => name === normalized;
  }
  const segments = {
    first: parts[0] ?? "",
    last: parts.at(-1) ?? "",
    interior: parts.slice(1, -1),
  };
  return (name: string) => matchesStarSegments(segments, name);
}

/** Inspect recorded declarations, never materialize callbacks or evaluate runtime grants. */
export function previewContextTools(
  args: readonly string[],
  report: SessionSystemPromptReport | null,
) {
  const patterns = [];
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const pattern = args[index + 1];
    if ((flag !== "--allow" && flag !== "--deny") || !pattern || pattern.startsWith("--")) {
      return USAGE;
    }
    patterns.push({ flag, pattern, matches: nameMatcher(pattern), found: false });
  }
  if (!report) {
    return "No actual run tool catalog is cached for this session. Send a normal message first.";
  }

  const selected: string[] = [];
  const denied: string[] = [];
  let unselected = 0;
  for (const tool of [...report.tools.entries, ...(report.tools.deferred?.entries ?? [])]) {
    const name = tool.name.toLowerCase();
    let allow = false;
    let deny = false;
    for (const pattern of patterns) {
      if (pattern.matches(name)) {
        pattern.found = true;
        allow ||= pattern.flag === "--allow";
        deny ||= pattern.flag === "--deny";
      }
    }
    if (!allow && !deny) {
      unselected++;
      continue;
    }
    const owner = tool.serverName ?? tool.sourceName;
    const source = [tool.source, owner].filter(Boolean).join(": ") || "source not recorded";
    (deny ? denied : selected).push(sanitizeChatDisplayText(`${tool.name} (${source})`));
  }
  const unmatched = patterns.filter((p) => !p.found).map((p) => sanitizeChatDisplayText(p.pattern));
  return formatFencedCodeBlock(
    [
      "Last run tool selection preview. This does not grant execution or change any policy.",
      `Selected (${selected.length}): ${selected.toSorted().join(", ") || "none"}`,
      `Denied (${denied.length}): ${denied.toSorted().join(", ") || "none"}`,
      `Not selected by any pattern: ${unselected}`,
      ...(unmatched.length ? [`No catalog match: ${unmatched.join(", ")}`] : []),
    ].join("\n"),
  );
}
