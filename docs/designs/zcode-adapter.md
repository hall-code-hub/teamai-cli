# ZCode Adapter Design

First-class `zcode` support in teamai, following the OpenCode adapter (commit
`637578f`) as the structural template. ZCode (zhipu AI's Claude Code variant)
was verified against a real machine install (ZCode 3.8.1, Windows) plus the
official docs at zcode.z.ai.

## Evidence base

| Claim | Source |
|---|---|
| User config: `~/.zcode/cli/config.json`, keys `skills` / `mcp` / `plugins` / `command` | real machine file |
| Workspace config: `<repo>/.zcode/config.json` (or `zcode.json`) | official configuration guide + docs |
| Skills: `~/.zcode/skills/`, `<repo>/.zcode/skills/` (also `.agents/skills` fallbacks) | official configuration guide |
| Rules: `.zcode/rules` used on real machine; no official doc page (loaded like Claude rules / via AGENTS.md references) | real machine `~/.zcode/rules/` |
| Subagents: `~/.zcode/agents/<name>.md`, Markdown + frontmatter, `name` + `description` required | official `/en/docs/subagents` |
| Hooks: user-level `hooks` key in `~/.zcode/cli/config.json` shaped `{ enabled, events: { <Event>: [{ matcher?, hooks: [...] }] } }`; **workspace-level hooks are ignored entirely** (`config_project_hooks_ignored`); `hooks.enabled: true` is mandatory | official `/en/docs/hooks` + zcode-guide plugin SKILL.md |
| Hook events: exactly seven — `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PermissionRequest`, `PostToolUse`, `PostToolUseFailure`, `Stop` | official hooks doc |
| Hook `matcher` is a **case-sensitive regex**; an invalid regex never matches; omitted matcher matches everything | zcode-guide plugin SKILL.md |
| MCP: user `~/.zcode/cli/config.json` → `mcp.servers`; workspace `<repo>/.zcode/config.json` → `mcp.servers`; `.agents/mcp.json` fallback uses `mcpServers` and is ignored when the `.zcode` config has servers | official `/en/docs/mcp-services` + configuration guide |
| MCP stdio entry: `{ command, args, env }` (no `type`); http entry: `{ url, http_headers }` — **`http_headers`, not `headers`** | real machine config.json entries |
| Instructions: user `~/.zcode/AGENTS.md`, workspace `<repo>/AGENTS.md` | official configuration guide |

## Per-resource plan

| Resource | toolPaths field | Value | Notes |
|---|---|---|---|
| Skills | `skills` | `.zcode/skills` | Same relative path in both scopes — no `userScope` needed. |
| Rules | `rules` | `.zcode/rules` | Plain directory copy, same as claude. ZCode has no activation glob (unlike OpenCode). |
| Agents | `agents` | `.zcode/agents` | User scope verified by docs. Rendered in Claude format (frontmatter `name`/`description`/`model`/`tools` is ZCode-compatible). |
| Settings (hooks) | `settings` | `.zcode/cli/config.json` | Correct for a HOME base dir (user scope). Project scope is stripped (see below) because ZCode ignores workspace hooks. |
| claudemd | — | not set | User scope reads `~/.zcode/AGENTS.md` but project scope reads `<repo>/AGENTS.md` — one value cannot serve both and `userScope` has no `claudemd` field. Left unset (teamai skips it); recorded as an open item. |
| MCP user | `mcp` | `.zcode/cli/config.json` | Server map nested at `mcp.servers` (two levels, unlike everyone else's single `mcpServers`). |
| MCP project | `mcpProject` | `.zcode/config.json` | Workspace MCP is real and auto-connected. |

## Design decisions

### 1. Hooks get a dedicated `zcode` backend, not the claude branch

The zcode on-disk shape is *almost* Claude's, with four differences that make
reusing `reconcileClaudeFormat` wrong:

1. Events nest one level deeper: `hooks.events.<Event>`, not `hooks.<Event>`.
2. `hooks.enabled: true` must be set or nothing runs.
3. `matcher` is a regex — the claude renderer's `matcher: "*"` is an invalid
   regex in zcode and would silently never match. The zcode renderer omits the
   matcher for `*` and passes other matchers through verbatim.
4. The config schema documents no `description` field, so managed-entry
   identification uses command markers + the manifest (the codex strategy).

A `reconcileZcodeFormat` function (mirroring `reconcileCodexFormat` structure,
plus the `events` nesting and `enabled` flag) keeps the claude path untouched.
`applyAgentHook` / `removeAgentHook` / `getHookStatus` / `hasTeamaiHooks` get
zcode branches that read/write `hooks.events` and match entries by command.

### 2. Project scope strips the zcode settings path

`settings` resolves against the scope base dir. In user scope it lands on
`~/.zcode/cli/config.json` (the one effective hooks location). In project
scope it would land on `<repo>/.zcode/cli/config.json` — a path zcode never
reads, i.e. a junk file. ZCode ignores workspace hooks entirely, so there is
no effective project-scope injection site: a `hookToolPathsForScope()` helper
strips the zcode `settings` field when scope is `project`, and the two call
sites that use a scope-derived base dir (`reconcileTeamHooksForConfig` and the
pull auto-migration) route through it. `teamai hooks inject/remove` already
resolve to a HOME base dir in both scopes and keep working.

### 3. MCP: dot-path server key for the two-level nest

`MCP_SERVER_KEY['zcode'] = 'mcp.servers'`. `readJsonDoc` / `applyJson` learn to
resolve a dotted key: reading walks `data.mcp.servers` (missing intermediate
levels read as an empty map; a non-object intermediate aborts the injection),
writing recreates the nest with key-level surgery so sibling keys under `mcp`
and every other top-level key survive. The renderer emits:

- stdio: `{ command, args?, env? }` — no `type`, matching real entries.
- http: `{ url, http_headers? }` — zcode's header key is `http_headers`.
- No `enable`/`enabled` field: absence means enabled, which sidesteps the
  enable-vs-enabled discrepancy between the docs and real config files.
- sse is skipped (only stdio + streamable http are attested).

### 4. Agents reuse the Claude renderer

ZCode's subagent format (`~/.zcode/agents/<name>.md`, frontmatter
`name`/`description` required, `model`/`tools` compatible) accepts the Claude
render as-is: `renderForTool('zcode')` delegates to `renderForClaude` and
`reverseFromZcode` delegates to `reverseFromClaude`. `tool_extras.zcode` is
added to the AgentSpec type for future per-tool overrides.

### 5. Registry and defaults

- `KNOWN_AGENTS`: `{ id: 'zcode', displayName: 'ZCode', category: 'coding', skillsPath: '.zcode/skills' }`.
- `toolPaths` default gains the zcode entry (see table above).
- `SELF_MODE_AGENT_CHOICES` stays unchanged (the OpenCode adapter did not add
  itself there either).
- skills/rules/agents deployment sites need no changes: they already iterate
  `scopedToolPaths`, and zcode's paths are identical across scopes.

## Open items (deliberately not done)

1. **claudemd injection** — blocked on `userScope` lacking a `claudemd` field.
   Extending `userScope` (and its consumers) would allow
   `claudemd: 'AGENTS.md'` + `userScope.claudemd: '.zcode/AGENTS.md'`.
2. **Project-scope hooks** — impossible today: zcode logs
   `config_project_hooks_ignored` and never runs workspace hooks. Revisit if
   zcode lifts the restriction.
3. **`enable` vs `enabled` field name** — docs say toggling writes `enable:
   false`; the real machine file carries `enabled`. teamai writes neither
   (absent = enabled), so the discrepancy never reaches disk.
4. **Workspace-level subagents** — the docs say Settings can only manage
   user-level subagents today. We still deploy to `<repo>/.zcode/agents` in
   project scope (the directory convention matches); if zcode never reads it,
   the files are inert but harmless.

## Test plan

All tests run against temp dirs with a stubbed `HOME`; the real `~/.zcode` is
never touched.

- `agent-format.test.ts`: render for zcode equals the claude shape; reverse
  round-trip through the zcode case.
- `mcp-reconcile.test.ts`: zcode target writes `mcp.servers` in both shapes,
  preserves unrelated keys (`skills` overrides, sibling servers), removes
  dropped servers, skips sse, project scope writes `<root>/.zcode/config.json`.
- `hooks` (new zcode describe): reconcile writes the nested `events` shape with
  `enabled: true`, omits `*` matchers, keeps concrete matchers, writes no
  `description`, is idempotent, `removeAll` clears only teamai entries, user
  entries survive; `hookToolPathsForScope` strips zcode settings in project
  scope only.
- registry: KNOWN_AGENTS has zcode; toolPaths default includes zcode.

## Field finding (2026-08-24 evening, post-merge validation on real machine)

**Config-file hooks are inert on ZCode 3.8.1.** Two fresh sessions plus an
independent probe hook (timestamp appended to a file, no teamai involvement)
produced zero executions, while the injected block is schema-compliant
(`hooks.enabled: true` set, seven-event names, correct nesting) and the
command itself runs fine manually (`teamai hook-dispatch session-start
--tool zcode` exits 0). Conclusion: the config-file hooks channel documented
at zcode.z.ai/docs/hooks does not actually execute on this build.

Implications:
- Skills/rules/agents/MCP sync for zcode is **unaffected** (those go through
  `teamai pull`, not hooks) — zcode works as a **manual-pull** agent, like
  codex was originally described.
- The hooks auto-sync channel needs an alternative (plugin-shaped
  `hooks/hooks.json` is documented to always run) or stays manual until a
  future ZCode build honors config-file hooks.
- The injected `hooks` block is harmless (never executed); keep or remove
  at will.

## Field finding CORRECTED (same evening, final)

The "inert" conclusion above was wrong. ZCode does load and run config-file
hooks on every session (no app restart needed) — they were *failing silently*:
`bash -lc "…" || true` breaks under cmd.exe (`||` chains in cmd semantics,
`true` is not a builtin) and non-JSON stdout fails strict validation
(`hook.run.failed` events with `source: config.SessionStart.0.0` in ZCode's
log were present all along). Fix in `fd5fae2`: render zcode entries as
shell-free `process` hooks (node.exe + argv). Verified live: new session at
20:09 pulled automatically (state.json lastPull updated, session_start
reported, zero failures). Lesson: check the host's `hook.run.failed` events
before concluding "not executed"; a silent-failure wrapper hides the truth.
