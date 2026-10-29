import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { buildCurrentInboundPrompt } from "../../agents/embedded-agent-runner/run/runtime-context-prompt.js";
import * as gitCoauthorPrompt from "../../agents/git-coauthor-prompt.js";
import { MESSAGE_TOOL_ONLY_DELIVERY_HINT } from "../../plugin-sdk/message-tool-delivery-hints.js";
import * as userPreferences from "../../state/user-preferences.js";
import { bindRequesterProfile } from "../requester-profile.js";
import { parseSoftResetCommand } from "./commands-reset-mode.js";
import type { prepareReplyRunContext, PreparedReplyRunContext } from "./get-reply-run-context.js";
import { prepareReadyReply } from "./get-reply-run-context.test-support.js";
import { baseParams } from "./get-reply-run.test-support.js";
import { CURRENT_MESSAGE_MARKER } from "./history.js";
import { finalizeInboundContext } from "./inbound-context.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

type Options = Parameters<typeof prepareReplyRunContext>[0];
type Additions = Parameters<PreparedReplyRunContext["buildPromptBodies"]>[0];
const context = (Body: string, fields: Options["ctx"] = {}) =>
  finalizeInboundContext({ Body, BodyStripped: Body, ...fields });
const currentPrompt = (envelope: Awaited<ReturnType<typeof envelopeFor>>) =>
  buildCurrentInboundPrompt({
    context: envelope.currentInboundContext,
    prompt: envelope.prefixedCommandBody,
  });

async function envelopeFor(
  sessionCtx: Options["sessionCtx"],
  options: Partial<Options> = {},
  additions: Additions = {},
) {
  const prepared = await prepareReadyReply({
    isNewSession: false,
    ctx: sessionCtx,
    sessionCtx,
    ...options,
  });
  return prepared.buildPromptBodies({ prefixedBody: prepared.prefixedBodyBase, ...additions });
}

async function resetEnvelope(Provider: string, soft: boolean) {
  const workspaceDir = tempDirs.make("openclaw-prompt-reset-");
  await fs.mkdir(path.join(workspaceDir, "memory"));
  await fs.writeFile(
    path.join(workspaceDir, "memory", "2026-04-11.md"),
    "Startup context sentinel",
  );
  vi.spyOn(Date, "now").mockReturnValue(Date.UTC(2026, 3, 11, 18));
  const body = soft ? "/reset soft re-read persona files" : "/reset";
  const ctx = finalizeInboundContext({
    Body: body,
    RawBody: body,
    CommandBody: body,
    CommandAuthorized: true,
    Provider,
    Surface: Provider,
    ChatType: "direct",
    SenderId: "telegram-user-1",
  });
  const sessionCtx = finalizeInboundContext({ ...ctx, Body: "", BodyStripped: "", agentText: "" });
  const params = baseParams({
    ctx,
    sessionCtx,
    cfg: {
      agents: {
        defaults: {
          userTimezone: "UTC",
          startupContext: { enabled: true, applyOn: ["reset"], dailyMemoryDays: 1 },
        },
      },
    },
    workspaceDir,
    isNewSession: !soft,
    resetTriggered: !soft,
  });
  const softReset = parseSoftResetCommand(body);
  params.command = {
    ...params.command,
    surface: Provider,
    channel: Provider,
    rawBodyNormalized: body,
    commandBodyNormalized: body,
    isAuthorizedSender: true,
    ...(softReset.matched ? { softResetTriggered: true, softResetTail: softReset.tail } : {}),
  };
  return envelopeFor(sessionCtx, params);
}

it.each([
  ["telegram", ""],
  ["slack", "re-read persona files"],
])(
  "keeps %s reset notes visible and startup context out of transcripts",
  async (Provider, softResetTail) => {
    const envelope = await resetEnvelope(Provider, Boolean(softResetTail));
    for (const text of [
      '"sender":{"id":"telegram-user-1"}',
      "Startup context sentinel",
      softResetTail,
    ]) {
      expect(envelope.prefixedCommandBody).toContain(text);
    }
    expect(envelope).toMatchObject({
      transcriptCommandBody: softResetTail || "[OpenClaw session reset]",
      currentInboundContext: undefined,
    });
  },
);

it("keeps Telegram reply text beside its marker", async () => {
  const threadNote = "[Thread starter - for context]\nPlanning the picnic next month.";
  const sessionCtx = context("Tldr", {
    Provider: "telegram",
    ChatType: "group",
    MessageSid: "42",
    ReplyToId: "41",
    ReplyToBody: "The restore finished.",
    ReplyToSender: "Example Bot",
    InboundEventKind: "user_request",
  });
  const envelope = await envelopeFor(
    sessionCtx,
    { opts: { sourceReplyDeliveryMode: "message_tool_only" } },
    { threadContextNote: threadNote, systemEventBlocks: ["System: Scheduled digest."] },
  );
  const prompt = currentPrompt(envelope);
  expect(prompt).toContain('[Replying to: "The restore finished."]\n#42: Tldr');
  expect(envelope.transcriptCommandBody).toBe("Tldr");
  expect(prompt).not.toContain("PR attribution:");
  expect(prompt.indexOf(threadNote)).toBeGreaterThanOrEqual(0);
  expect(prompt.indexOf(threadNote)).toBeLessThan(prompt.indexOf("System: Scheduled digest."));
  expect(prompt.indexOf("System: Scheduled digest.")).toBeLessThan(
    prompt.indexOf(CURRENT_MESSAGE_MARKER),
  );
  expect(envelope.currentInboundContext?.fragments).toContainEqual({
    kind: "runtime-instruction",
    text: CURRENT_MESSAGE_MARKER,
  });
  for (const text of ["System: Scheduled digest.", MESSAGE_TOOL_ONLY_DELIVERY_HINT]) {
    expect(prompt).toContain(text);
    expect(prompt.indexOf(text)).toBeLessThan(prompt.indexOf("Current message:"));
  }
});

it.each(["message_tool_only", "automatic"] as const)(
  "projects raw room events separately from resumable history with %s delivery",
  async (sourceReplyDeliveryMode) => {
    const Provider = sourceReplyDeliveryMode === "automatic" ? "webchat" : "slack";
    const envelope = await envelopeFor(
      context("[Chat history]\nAlice: old context\n\nBob: current note", {
        RawBody: "current note",
        CommandBody: "current note",
        Provider,
        Surface: Provider,
        ChatType: "group",
        InboundEventKind: "room_event",
        MessageSid: "2002",
        SenderName: "Bob",
        InboundHistory: [{ sender: "Alice", body: "old context", messageId: "2001" }],
        SessionTranscriptContext: { historyLimit: 20, historyKind: "recent" },
      }),
      { opts: { sourceReplyDeliveryMode } },
      { threadContextNote: "Thread note", systemEventBlocks: ["System event"] },
    );
    expect(envelope).toMatchObject({
      prefixedCommandBody: "#2002 Bob: current note",
      queuedBody: "#2002 Bob: current note",
      transcriptCommandBody: "#2002 Bob: current note",
    });
    const { text, resumableText, fragments } = envelope.currentInboundContext!;
    expect(text).toContain("Room context:");
    expect(text).toContain("Alice: old context");
    expect(text.split("old context")).toHaveLength(2);
    expect(resumableText).not.toContain("old context");
    expect(text).toContain(
      "Treat this message as observed room activity, not a request. You were not explicitly tagged or mentioned in this room event. Default: stay silent. Only respond if you have something useful, substantial, or important to add. A previous mention or reply is not an invitation to keep talking.",
    );
    for (const directive of ["message(action=send)", "your final text here stays private"]) {
      expect(text.includes(directive)).toBe(sourceReplyDeliveryMode === "message_tool_only");
    }
    for (const prompt of [text, resumableText]) {
      for (const part of ["Conversation info:", "Thread note", "System event"]) {
        expect(prompt).toContain(part);
      }
      expect(prompt).not.toContain("current note");
      expect(prompt).not.toContain(CURRENT_MESSAGE_MARKER);
    }
    expect(fragments).toEqual(
      expect.arrayContaining([
        { kind: "conversation-data", text: "Thread note" },
        { kind: "conversation-data", text: "System event" },
      ]),
    );
    expect(envelope.queuedBody).not.toContain("[Chat history]");
  },
);

it("keeps completed audio transcripts in room-event bodies", async () => {
  const transcript = "turn left at the next light";
  const agentText = `[Audio]\nTranscript:\n${transcript}`;
  const transportEnvelope = "[Discord channel #ambient]\n[media attached: voice-message.ogg]";
  const ctx = context(transportEnvelope, {
    BodyForAgent: agentText,
    RawBody: transportEnvelope,
    CommandBody: transportEnvelope,
    Transcript: transcript,
    MediaUnderstanding: [
      {
        kind: "audio.transcription",
        attachmentIndex: 0,
        text: transcript,
        provider: "groq",
      },
    ],
    Provider: "discord",
    ChatType: "channel",
    InboundEventKind: "room_event",
    MessageSid: "2003",
    SenderName: "Alice",
  });
  const sessionCtx = finalizeInboundContext({ ...ctx, BodyStripped: agentText });

  const envelope = await envelopeFor(sessionCtx, { ctx });

  expect(envelope.queuedBody).toBe(`#2003 Alice: ${agentText}`);
  expect(envelope.transcriptCommandBody).toBe(envelope.queuedBody);
  expect(envelope.queuedBody).not.toContain(transportEnvelope);
});

it("keeps sparse inbound positions separate from appended preprojected media", async () => {
  const sharedPath = "/tmp/shared.png";
  const sessionCtx = context("inspect these", {
    media: [
      {},
      { path: "/tmp/voice.ogg", contentType: "audio/ogg", transcribed: true },
      { path: sharedPath, contentType: "image/png" },
      { path: sharedPath, contentType: "image/png" },
    ],
  });
  const params = { media: [{ path: "/tmp/preprojected.pdf", contentType: "application/pdf" }] };
  const first = await envelopeFor(sessionCtx, {}, params);
  const rebuilt = await envelopeFor(
    sessionCtx,
    { ctx: { ...sessionCtx, media: [...(sessionCtx.media ?? []), { path: "/tmp/later.png" }] } },
    { ...params, systemEventBlocks: ["context changed"] },
  );

  expect(first.inboundMediaIndexes).toEqual([2, 3]);
  expect(first.media?.map((fact) => fact.path)).toEqual([
    sharedPath,
    sharedPath,
    "/tmp/preprojected.pdf",
  ]);
  expect(rebuilt.inboundMediaIndexes).toEqual([2, 3, 4]);
  expect(first.prefixedCommandBody).toBe(
    `[media attached: 2 files]\n[media attached 1/2: ${sharedPath} (image/png)]\n[media attached 2/2: ${sharedPath} (image/png)]\ninspect these`,
  );
  expect(first.queuedBody).toBe(first.prefixedCommandBody);
  expect(first.transcriptCommandBody).toBe(first.prefixedCommandBody);
  expect(sessionCtx.media?.map((fact) => fact.path)).toEqual([
    undefined,
    "/tmp/voice.ogg",
    sharedPath,
    sharedPath,
  ]);
});

it("keeps requester trailers in full and resumed backend prompt projections", async () => {
  const trailer = "Co-authored-by: requester-c <9101+requester-c@users.noreply.github.com>";
  vi.spyOn(gitCoauthorPrompt, "resolveRequestGitCoauthorPrompt").mockResolvedValue(trailer);
  const envelope = await envelopeFor(
    context("Create the requested commit", {
      Provider: "discord",
      Surface: "discord",
      ChatType: "group",
      InboundEventKind: "room_event",
    }),
    { agentId: "main", sessionKey: "agent:main:main" },
  );
  expect(envelope.currentInboundContext?.text).toContain(trailer);
  expect(envelope.currentInboundContext?.resumableText).toContain(trailer);
  expect(envelope.currentInboundContext?.fragments).toContainEqual({
    kind: "runtime-instruction",
    text: trailer,
  });
  expect(envelope.transcriptCommandBody).not.toContain(trailer);
});

it("scopes PR attribution to each requester turn in the same session", async () => {
  const preferences = new Map<string, unknown>();
  vi.spyOn(userPreferences, "getUserPreferenceValues").mockImplementation(async (ids) => ({
    values: new Map(ids.map((id) => [id, preferences.get(id)])),
    isCurrent: () => true,
  }));
  const sessionEntry = { sessionId: "attribution-session", updatedAt: 1 };
  const history: string[] = [];
  // Exercise the real prompt composition; storage is fixed I/O, not an attribution decision.
  // Retained instructions are checked for explicit scope, not model compliance.
  for (const [sender, preference, incognito, enabled] of [
    ["alice", undefined, false, false],
    ["alice", false, false, false],
    ["alice", true, false, true],
    ["bob", undefined, false, false],
    ["alice", false, false, false],
    ["alice", true, true, false],
    ["alice", true, false, true],
  ] as const) {
    preferences.set(sender, preference);
    const sessionCtx = context("Create a PR", {
      Provider: "discord",
      ChatType: "group",
      SenderId: sender,
      InboundEventKind: "user_request",
    });
    bindRequesterProfile(sessionCtx, { id: sender, displayName: sender, isCurrent: () => true });
    const envelope = await envelopeFor(sessionCtx, {
      sessionKey: "agent:main:discord:channel:attribution",
      sessionEntry: { ...sessionEntry, incognito: incognito || undefined },
      isNewSession: history.length === 0,
    });
    const prompt = currentPrompt(envelope);
    expect(prompt.includes("PR attribution:"), `${sender}/${preference}/${incognito}`).toBe(
      enabled,
    );
    if (enabled) {
      expect(prompt).toContain("only to this request from this verified requester");
      expect(prompt).toContain("Do not carry it forward to later requests or other requesters");
      expect(prompt).toContain(
        "If a later request has no enabled attribution block, do not add the footer",
      );
      expect(prompt).toContain("<!-- openclaw:attribution=off -->");
      expect(prompt).toContain("Never add it when reviewing or updating an existing PR");
    } else {
      expect(prompt).not.toContain("Made with [OpenClaw]");
      expect(prompt).not.toContain("PR attribution preference");
    }
    expect(envelope.transcriptCommandBody).toBe("Create a PR");
    history.push(prompt);
  }
  expect(history.filter((prompt) => prompt.includes("PR attribution:"))).toHaveLength(2);
});
