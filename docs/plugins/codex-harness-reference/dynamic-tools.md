---
summary: "How OpenClaw dynamic tools are exposed to Codex app-server turns"
read_when:
  - You need to know which OpenClaw tools Codex can call
  - You are changing dynamic tool loading or exclusions
  - You are debugging the Codex tool payload
title: "Codex dynamic tools"
sidebarTitle: "Dynamic tools"
---

Which OpenClaw dynamic tools reach a Codex turn, and how they are loaded. Part of the [Codex harness reference](/plugins/codex-harness-reference); [Where each section moved](/plugins/codex-harness-reference#where-each-section-moved) lists every section.

## Dynamic tools

Codex dynamic tools default to `searchable` loading, exposed under the
`openclaw` namespace with `deferLoading: true`. OpenClaw normally does not
expose dynamic tools that duplicate Codex-native workspace operations or
Codex's own tool-search surface:

- `read`
- `write`
- `edit`
- `apply_patch`
- `exec`
- `process`
- `dispatch_action`
- `tool_describe`
- `tool_search`

`progress_card` is not filtered with those native workspace tools. It remains
available through the OpenClaw dynamic-tool bridge as the durable session status
surface.

When the native surface is disabled, OpenClaw publishes allowed dynamic tools
directly instead of requiring unavailable native discovery. This includes managed
GitHub identity and sandbox-backed execution. Native-enabled threads retain
searchable, direct, and code-mode-only loading. In native JavaScript `exec`,
`ALL_TOOLS` and `tools` are JavaScript globals, never shell environment variables.
OpenClaw shell tools execute operating-system commands.

When a finite runtime allowlist disables native Code Mode, OpenClaw sends an
empty execution-environment selection. In that direct, unsandboxed case,
OpenClaw keeps its policy-filtered `exec` and `process` tools as the shell
fallback. Runtime allowlists and `codexDynamicToolsExclude` still apply.

`tools.gatewayPolicy` adds a required allowlist for Gateway-supplied tools and
their actions. The adapter applies it after tool additions and exclusions, to
both declarations and executable callbacks. It does not restrict Codex-native
coding tools or subagents. Existing ordinary restrictions and
`codexDynamicToolsExclude` can narrow access further.

Callbacks check the deployment policy captured when their tools are constructed,
including calls from restored threads. Policy changes require a Gateway restart
or replacement after affected old work ends. Reconstructed callbacks use the new
policy; saved native declarations retain their fingerprint, so a previously
advertised tool can return a policy denial. Direct human Gateway administration
keeps its existing permissions.

While native children protect a managed parent thread, OpenClaw retains the
declarations accepted by that thread. Each turn still uses fresh executable
bindings and current authority; removed tools and changed definitions remain
unavailable until the thread can accept new declarations. Conversation context
travels through the existing parent-local inference relay on each request, while
configured policy stays in the native thread. Connections without that relay
retain their existing creation-policy checks.

Most remaining OpenClaw integration tools, such as messaging, media, cron,
browser, nodes, gateway, and `web_search`, are available
through Codex tool search under that namespace. This keeps the initial model
context smaller. A small set of tools stay directly callable regardless of
`codexDynamicToolsLoading`, because Codex tool search can be unavailable or
resolve a connector-only universe: `agents_list`, `sessions_spawn`, and
`sessions_yield`. Developer instructions still steer normal Codex subagents
toward native `spawn_agent` for work using only Codex-native tools. New delegated
work that needs OpenClaw tools uses the available `sessions_spawn` route with
`runtime="subagent"` when its schema exposes that selector. Native children can
inherit dynamic tool schemas without an OpenClaw executor. Existing native
children keep their native follow-up path; tool failures do not migrate them
to managed workers. Explicit ACP delegation still uses `sessions_spawn`.
The opt-in [native-child host policy](#native-child-host-tools) below permits a
narrower exception for explicitly selected tools.
Message-tool-only source replies also stay direct, since that is a
turn-control contract.

Codex Code Mode projects generic OpenClaw dynamic-tool results as text. Parse a
JSON result before reading fields. Nested dynamic calls are serialized by the
Codex runtime, so `Promise.all` does not submit them concurrently; use a
bounded sequential launch loop when starting collector children.

Tools marked `catalogMode: "direct-only"`, including the OpenClaw `computer`
tool and regular-agent `openclaw` delegation, are grouped under `openclaw_direct`.
OpenClaw adds that namespace to Codex's
`features.code_mode.direct_only_tool_namespaces` list without replacing
operator-supplied entries. Codex therefore exposes those tools as
`DirectModelOnly` in normal and code-mode-only threads instead of routing them
through nested Code Mode `tools.*` calls. This preserves image-bearing results,
which nested Code Mode otherwise flattens to text. It also keeps delegated human
approval on the direct model call: a yielded script cell must not let the model
finish its turn while that approval is still waiting.

Set `codexDynamicToolsLoading: "direct"` only when connecting to a custom
Codex app-server that cannot search deferred dynamic tools or when debugging
the full tool payload.

For supported checks before inference, see
[Codex pre-turn verification](/plugins/codex-harness/commands#verify-tool-access-before-a-codex-turn).

## Native-child host tools

Native children have no OpenClaw host-tool access by default, even when Codex
inherits their declarations. To delegate selected tools, configure the Codex
plugin:

```json5
{
  plugins: {
    entries: {
      codex: {
        config: {
          nativeChildTools: {
            allow: ["search_notes", "read_note", "skills_read", "better_patch", "research__get_*"],
            deny: ["research__delete_*"],
          },
        },
      },
    },
  },
}
```

These example memory, patch and MCP names depend on installed tools. Use their
canonical OpenClaw names, not JavaScript wrapper spellings or plugin IDs. The
existing tool-policy matcher supplies name normalization, exact matching and
`*` globs. Deny wins. Omitted policy or an empty `allow` grants nothing; `*`
explicitly selects every otherwise eligible tool. A newly available matching
tool can expand a wildcard grant when a fresh surface is constructed. A name
such as `get_*` does not prove that its operations are read-only.

**This delegates host authority, not the child's native sandbox.** Selected
calls run under the owning OpenClaw session/requester's host restrictions,
narrowed by this policy. A native read-only child can therefore write through
an allowed host file tool. Existing argument validation, approvals, workspace
restrictions, action policy and source revocation still apply. An allowlist
cannot create credentials or restore a denied parent tool. The parent's tool
surface and the child's native shell, Code Mode and collaboration are unchanged.
Policy changes use the existing Gateway restart/replacement semantics, not a
new hot-reload mechanism.

Each admitted direct child gets fresh executors and a separate execution owner.
It can continue using them after successful parent completion or yield. A later
accepted parent follow-up gets its own captured authority, including when the
input is queued before a receiver turn exists. Child completion, cancellation,
failed parent completion or source revocation closes the corresponding grant.
Unknown children and nested descendants without a direct grant cannot borrow
it. Identical repeated calls share the same execution; a repeated call ID with
different arguments is rejected.

Foreground conversation controls, reply delivery, managed delegation, questions,
goals and progress cards are unsupported in children. Personal skill-library
authoring (`skill_library`) is also foreground-bound; ordinary skill reads are
not excluded. Codex host-process
projections (`exec`, `process`, `gateway_exec`, `gateway_process`, `node_exec`,
`sandbox_exec`, `sandbox_process`) are also unsupported; use the child's native
shell for native execution. Memory, skills, file and plugin/service tools are
not excluded merely because they are host-owned. Worker-turn and settled-receipt
capabilities are not transferable through this feature.

### Inspect a grant

With file logging at `logging.level: "debug"`, inspect `openclaw logs --json`
for these records:

- `codex native-child tool policy`: the owning turn's eligible canonical names,
  plugin/MCP owners where available, and unmatched allow/deny patterns.
- `codex native-child executable tools`: the child run/thread's reconstructed
  surface, checked against the declarations already registered with Codex.

Both report `allowed`, `denied`, `unavailable` or `unsupported`. Inspection
does not invoke tools. The first record is eligibility, not proof of a live
child executor; the second still does not bypass per-call checks or approvals.
Unavailable or changed schemas cannot be rescued by a wildcard. Rejected calls
explain the relevant policy or ownership failure.

Persistent developer guidance describes the host/native authority split, and
turn guidance names eligible tools. Codex can still inherit declarations that
are not executable. A schema is not a grant; children must obey the execution
result rather than respawning to evade a denial.

## Protected conversation continuity

While native work protects a thread, OpenClaw retains its accepted tool declarations.
Those declarations do not grant execution: current tools and fallback executors must
still match the accepted description and canonical JSON schema after preparation.
Changing object-key order is compatible; changing the declaration is not. Invalid
saved catalog receipts stop reuse without replacing the thread or repairing its receipt.

Inbound and private-completion producers identify their exact transient conversation
context within `extraSystemPrompt`. Codex delivers the complete current snapshot,
together with current tool bindings, through the existing parent-local inference
and native developer-handoff paths. Managed inference receives it on every admitted
parent request, including immediate post-compaction continuation; native
additional-context deduplication is not used.

Without a parent-local inference relay, OpenClaw also keeps the initial conversation
snapshot in creation policy because native compaction can discard injected history
before the host can refresh it. Reused threads receive a full handoff before each
turn and after compaction, but a protected thread still refuses a changed creation
snapshot instead of replacing or borrowing that thread. As with the existing native
refresh handoff, an immediate native continuation can precede the host callback and
therefore lack fresh turn context. No new durable cache is added.
Configured conversation policy, execution hints, and caller-added instructions
remain part of persistent thread identity. Invalid or stale annotations leave the
full prompt persistent. Other harnesses still receive the complete prompt unchanged.
