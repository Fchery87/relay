# Harness Extensibility Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Bring Relay to parity with Claude Code / Codex / OpenCode / Pi on the user-extensibility layer: project trust gate, slash commands (custom + built-ins), SKILL.md skills, lifecycle hooks, a todo/progress tool, background bash, and a live provider & model directory (models.dev) with credential-gated model selection.

**Architecture:** All features land in the **legacy runtime** (the default `RELAY_RUNTIME_MODE=legacy` raw loop in `apps/daemon/src/agent-loop.ts`), behind clean seams so the kernel adopts them at cutover. Extension *sources* are markdown/JSON files at two scopes — project (`.relay/` in the repo, **gated by project trust**) and user (`<daemonHome>/`, always loaded). The daemon scans sources, publishes catalogs to Convex, the web composer consumes them reactively, and expansion/execution happens daemon-side. Every new tool routes through the existing governance chokepoint (`governed-tool-executor.ts`).

**Tech Stack:** Bun + TypeScript, Zod schemas in `@relay/shared`, Convex (follow `convex/_generated/ai/guidelines.md` and the existing `mutationGeneric`/`queryGeneric` + auth-helper patterns in `convex/conversations.ts`), React web app in `apps/web`, colocated `*.test.ts` bun tests.

**Phase order (dependencies):**
1. Groundwork: frontmatter parser + extension-scope resolver
2. Project trust gate (prerequisite — project-local config is an injection vector)
3. Slash commands (loader → Convex catalog → composer autocomplete → daemon expansion → built-ins)
4. Skills (SKILL.md standard)
5. Hooks (PreToolUse / PostToolUse / TurnStart / TurnEnd)
6. Todo tool + UI panel
7. Background bash
8. End-to-end wiring verification (phases 1–7)
9. Provider & model directory — models.dev, credentials, gated picker (independent of phases 2–7; can run in parallel after Phase 1, has its own verification task)

**UI palette rule (ADR 0004, non-negotiable):** patina = interactive chrome (autocomplete highlight, buttons). Brass = *the agent needs you* only (the trust prompt card). Todo progress markers are neither — use neutral emphasis.

**Convex schema discipline:** widen-only. New tables and new *optional* fields only. Run `bun run convex:dev` after every schema change and before daemon tests that hit Convex.

**Commit convention:** one commit per task, message given in each task. End every commit with the repo's standard trailer.

---

## Phase 1: Groundwork

### Task 1: Frontmatter parser in `@relay/shared`

Slash commands and skills both need markdown-with-frontmatter parsing. No YAML dependency — a strict `key: value` string subset is enough (same approach as Pi).

**Files:**
- Create: `packages/shared/src/frontmatter.ts`
- Test: `packages/shared/src/frontmatter.test.ts`
- Modify: `packages/shared/src/index.ts` (add export)

**Step 1: Write the failing test**

```ts
// packages/shared/src/frontmatter.test.ts
import { describe, expect, test } from "bun:test";
import { parseFrontmatter } from "./frontmatter";

describe("parseFrontmatter", () => {
  test("parses key: value pairs and body", () => {
    const doc = "---\ndescription: Review the diff\nargument-hint: [pr-number]\n---\nDo the review of $ARGUMENTS.";
    expect(parseFrontmatter(doc)).toEqual({
      attributes: { "argument-hint": "[pr-number]", description: "Review the diff" },
      body: "Do the review of $ARGUMENTS.",
    });
  });

  test("returns empty attributes when no frontmatter block", () => {
    expect(parseFrontmatter("just a body")).toEqual({ attributes: {}, body: "just a body" });
  });

  test("ignores malformed lines instead of throwing", () => {
    const doc = "---\ndescription: ok\nnot a pair\n---\nbody";
    expect(parseFrontmatter(doc).attributes).toEqual({ description: "ok" });
  });

  test("handles values containing colons", () => {
    const doc = "---\ndescription: run: everything\n---\nbody";
    expect(parseFrontmatter(doc).attributes.description).toBe("run: everything");
  });
});
```

**Step 2: Run it — expect FAIL** (`cd packages/shared && bun test src/frontmatter.test.ts`)

**Step 3: Implement**

```ts
// packages/shared/src/frontmatter.ts
export interface FrontmatterDocument {
  attributes: Record<string, string>;
  body: string;
}

export function parseFrontmatter(source: string): FrontmatterDocument {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(source);
  if (!match) return { attributes: {}, body: source };
  const attributes: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (key) attributes[key] = value;
  }
  return { attributes, body: source.slice(match[0].length) };
}
```

**Step 4: Run tests — expect PASS.** Add `export * from "./frontmatter";` to `packages/shared/src/index.ts`, run `bun run typecheck`.

**Step 5: Commit** — `feat(shared): frontmatter parser for commands and skills`

### Task 2: Extension-scope resolver

One module answers "which directories do I scan, at which scope?" for commands, skills, and hooks alike. Project scope only appears when trusted (trust wired in Phase 2 — for now the parameter exists).

**Files:**
- Create: `apps/daemon/src/extension-paths.ts`
- Test: `apps/daemon/src/extension-paths.test.ts`

**Step 1: Failing test**

```ts
// apps/daemon/src/extension-paths.test.ts
import { describe, expect, test } from "bun:test";
import { resolveExtensionRoots } from "./extension-paths";

describe("resolveExtensionRoots", () => {
  test("trusted project yields project scope before user scope", () => {
    expect(resolveExtensionRoots({ daemonHome: "/home/u/.config/relay", kind: "commands", projectRoot: "/repo", projectTrusted: true })).toEqual([
      { root: "/repo/.relay/commands", scope: "project" },
      { root: "/home/u/.config/relay/commands", scope: "user" },
    ]);
  });

  test("untrusted project yields user scope only", () => {
    expect(resolveExtensionRoots({ daemonHome: "/home/u/.config/relay", kind: "skills", projectRoot: "/repo", projectTrusted: false })).toEqual([
      { root: "/home/u/.config/relay/skills", scope: "user" },
    ]);
  });
});
```

**Step 2: FAIL. Step 3: Implement**

```ts
// apps/daemon/src/extension-paths.ts
import { join } from "node:path";

export type ExtensionScope = "project" | "user";
export type ExtensionKind = "commands" | "skills";

export function resolveExtensionRoots({ daemonHome, kind, projectRoot, projectTrusted }: {
  daemonHome: string;
  kind: ExtensionKind;
  projectRoot: string;
  projectTrusted: boolean;
}): Array<{ root: string; scope: ExtensionScope }> {
  const roots: Array<{ root: string; scope: ExtensionScope }> = [];
  if (projectTrusted) roots.push({ root: join(projectRoot, ".relay", kind), scope: "project" });
  roots.push({ root: join(daemonHome, kind), scope: "user" });
  return roots;
}
```

**Step 4: PASS + `bun run typecheck`. Step 5: Commit** — `feat(daemon): extension scope resolver`

---

## Phase 2: Project trust gate

Local decision store first, then the Convex surface, then the brass UI card. Until a project is trusted, project-scope commands/skills/hooks/settings are **silently skipped** and a trust request is published.

### Task 3: Local trust store

**Files:**
- Create: `apps/daemon/src/trust.ts`
- Test: `apps/daemon/src/trust.test.ts`

**Step 1: Failing test** (use a temp dir via `mkdtemp` from `node:fs/promises`, pattern as in `daemon-home.test.ts`)

```ts
// apps/daemon/src/trust.test.ts
import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TrustStore } from "./trust";

describe("TrustStore", () => {
  test("unknown project reports unknown, decisions persist across instances", async () => {
    const home = await mkdtemp(join(tmpdir(), "relay-trust-"));
    const store = new TrustStore({ daemonHome: home });
    expect(await store.get("/repo")).toBe("unknown");
    await store.set("/repo", "trusted");
    expect(await new TrustStore({ daemonHome: home }).get("/repo")).toBe("trusted");
  });

  test("untrusted decision persists and is distinguishable from unknown", async () => {
    const home = await mkdtemp(join(tmpdir(), "relay-trust-"));
    const store = new TrustStore({ daemonHome: home });
    await store.set("/repo", "untrusted");
    expect(await store.get("/repo")).toBe("untrusted");
  });
});
```

**Step 2: FAIL. Step 3: Implement** — `trust.json` in daemon home: `{ [projectPath]: { decision, decidedAt } }`. Read-on-get with in-memory cache, atomic write (write temp file + rename). Export `type TrustDecision = "trusted" | "untrusted"; type TrustState = TrustDecision | "unknown"`.

**Step 4: PASS. Step 5: Commit** — `feat(daemon): persistent project trust store`

### Task 4: Convex trust surface (widen `projects`)

**Files:**
- Modify: `convex/schema.ts` (projects table, ~line 25): add optional fields `trustState: v.optional(v.union(v.literal("requested"), v.literal("trusted"), v.literal("untrusted")))` and `trustRequestedAt: v.optional(v.number())`
- Modify: `convex/projects.ts`: add `requestTrust` (device-token auth, sets `trustState: "requested"` unless already decided) and `resolveTrust` (user auth, sets `trusted`/`untrusted`) mutations, and include trust fields in whatever query the web sidebar uses for projects
- Test: `convex/projects.convex.test.ts`

**Steps:** Read `convex/_generated/ai/guidelines.md` §Function guidelines + §Testing before writing. Write failing convex-test cases: (a) `requestTrust` marks an undecided project `requested`; (b) `requestTrust` is a no-op on a decided project; (c) `resolveTrust` stores the decision. Match the auth-helper usage of the existing mutations in `convex/projects.ts` exactly (device-token pattern for daemon calls, user-auth pattern for browser calls). Implement, `bun run convex:dev` to push, tests PASS.

**Commit** — `feat(convex): project trust request/resolve surface`

### Task 5: Daemon wiring — check trust per claim, request when project config exists

**Files:**
- Modify: `apps/daemon/src/agent-loop.ts` (claim site, ~line 69) and/or `apps/daemon/src/project-request-worker.ts`
- Modify: `apps/daemon/src/relay-client.ts` (add `requestTrust` + a way to read resolved trust — follow how the client already reads project state; sync remote decisions into the local `TrustStore`)
- Test: extend `apps/daemon/src/agent-loop.test.ts`

**Behavior to pin with a failing test first:**
1. On claim, if `.relay/` exists in the project root and local trust is `unknown` → call `gateway.requestTrust` once (idempotent) and proceed with **user scope only**.
2. When the remote decision comes back `trusted`/`untrusted`, write it to the local `TrustStore` so subsequent claims are offline-correct.
3. Trust state is passed into `resolveExtensionRoots` (used from Phase 3 on).

**Commit** — `feat(daemon): trust gate wired into claim path`

### Task 6: Web trust card (brass)

**Files:**
- Create: `apps/web/src/trust-card.tsx` + `apps/web/src/trust-card.test.tsx`
- Modify: `apps/web/src/workspace-sidebar.tsx` (render card when project `trustState === "requested"`), and add the item to the attention inbox source in `convex/attention.ts` (a `requested` trust state is a needs-you item)

**Steps:** Failing component test (pattern from `mcp-elicitation-card.test.tsx`): renders project path, explanatory line ("This project defines local commands, skills, or hooks. Loading them lets the repo influence the agent."), Trust / Don't trust buttons calling `projects:resolveTrust`. Brass styling per ADR 0004 (`docs/adr/0004-brass-and-patina-palette.md`) — this is a needs-you card, same visual family as approval cards. Implement, PASS, verify `bun run typecheck`.

**Commit** — `feat(web): brass trust card + attention inbox entry`

---

## Phase 3: Slash commands

### Task 7: Command file loader

**Files:**
- Create: `apps/daemon/src/slash-commands.ts`
- Test: `apps/daemon/src/slash-commands.test.ts`

Format (Claude Code–compatible so users can reuse existing command files): `.relay/commands/<name>.md` / `<daemonHome>/commands/<name>.md`, frontmatter keys `description`, `argument-hint`, `model` (optional catalog model id). Body is the prompt template with `$ARGUMENTS`, `$1`–`$9` placeholders.

**Step 1: Failing tests**

```ts
// apps/daemon/src/slash-commands.test.ts (loader section)
import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expandCommand, loadSlashCommands, parseSlashInvocation } from "./slash-commands";

async function commandDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "relay-cmd-"));
  await mkdir(dir, { recursive: true });
  return dir;
}

describe("loadSlashCommands", () => {
  test("loads name from filename, metadata from frontmatter", async () => {
    const dir = await commandDir();
    await writeFile(join(dir, "fix-issue.md"), "---\ndescription: Fix a GitHub issue\nargument-hint: [issue-number]\n---\nFix issue $1 following our conventions.");
    const commands = await loadSlashCommands([{ root: dir, scope: "project" }]);
    expect(commands).toEqual([{ argumentHint: "[issue-number]", description: "Fix a GitHub issue", model: undefined, name: "fix-issue", scope: "project", template: "Fix issue $1 following our conventions." }]);
  });

  test("project scope shadows user scope on name collision", async () => {
    const project = await commandDir();
    const user = await commandDir();
    await writeFile(join(project, "deploy.md"), "---\ndescription: p\n---\nproject deploy");
    await writeFile(join(user, "deploy.md"), "---\ndescription: u\n---\nuser deploy");
    const commands = await loadSlashCommands([{ root: project, scope: "project" }, { root: user, scope: "user" }]);
    expect(commands).toHaveLength(1);
    expect(commands[0].scope).toBe("project");
  });

  test("missing directory yields empty list, not an error", async () => {
    expect(await loadSlashCommands([{ root: "/nonexistent-relay-dir", scope: "user" }])).toEqual([]);
  });
});

describe("parseSlashInvocation / expandCommand", () => {
  test("parses /name plus argument string", () => {
    expect(parseSlashInvocation("/fix-issue 123 high")).toEqual({ args: "123 high", name: "fix-issue" });
    expect(parseSlashInvocation("plain message")).toBeUndefined();
    expect(parseSlashInvocation("/ not-a-command")).toBeUndefined();
  });

  test("substitutes $ARGUMENTS and positional $n", () => {
    expect(expandCommand({ args: "123 high", template: "Fix $1 at priority $2. Context: $ARGUMENTS" }))
      .toBe("Fix 123 at priority high. Context: 123 high");
  });

  test("unused placeholders become empty strings", () => {
    expect(expandCommand({ args: "", template: "Run $1 now" })).toBe("Run  now");
  });
});
```

**Step 2: FAIL. Step 3: Implement** — `loadSlashCommands` reads `*.md` in each root (readdir, skip on ENOENT), parses with `parseFrontmatter`, first scope wins per name, caps: 100 commands, 10KB template each (skip oversized with a `console.warn`). `parseSlashInvocation` regex: `/^\/([a-z0-9][a-z0-9:_-]*)(?:\s+([\s\S]*))?$/i`. `expandCommand` replaces `$1`–`$9` by whitespace-split args, then `$ARGUMENTS` by the raw arg string.

**Step 4: PASS. Step 5: Commit** — `feat(daemon): slash command loader and template expansion`

### Task 8: Built-in commands

**Files:**
- Create: `apps/daemon/src/builtin-commands.ts`
- Test: `apps/daemon/src/builtin-commands.test.ts`

Two kinds. **Prompt built-ins** expand to a template that runs as a normal turn. **Action built-ins** are handled by the daemon/web without a normal model turn (dispatch wired in Task 10).

The top commands to ship (parity with Claude Code / Codex / OpenCode):

| Command | Kind | Behavior |
|---|---|---|
| `/init` | prompt | Scan the repo (README, package.json, build scripts, conventions) and create or refresh `AGENTS.md`. Template instructs: keep it under 200 lines, only non-obvious facts. |
| `/review` | prompt | Review the current working diff. Template runs `git diff` + `git diff --staged` via bash, reports findings by severity with `file:line` references. Reuses conventions already in `apps/daemon/src/git-review.ts` prompts where applicable. |
| `/commit` | prompt | Stage related changes and create a conventional commit; template mirrors the existing git-action guardrails (never `--force`, never amend others' commits). |
| `/pr` | prompt | Push the branch and open a PR with `gh pr create`; body summarizes the change from the branch's commits. |
| `/test` | prompt | Detect the project's test runner from package.json/config files, run the suite, report failures with output; fix only if the user asked. |
| `/compact` | action `compact` | Manual history compaction (Task 11). |
| `/context` | action `context` | Report context usage breakdown (Task 11). |
| `/rewind` | action `rewind` | Restore the latest checkpoint via the existing checkpoint restore path. |
| `/plan` | action `plan` | Switch the thread to `planPhase: "planning"` (field already exists on threads). |
| `/help` | action `help` | List all available commands with descriptions. |

**Steps:** Failing test asserting: catalog contains exactly these ten names; each prompt built-in has a non-empty `template` and `description`; each action built-in has `action` set and no template; user/project commands may **not** shadow built-ins (loader integration test: a project `init.md` is skipped with a warning). Implement as a `const BUILTIN_COMMANDS` array typed `BuiltinCommand = { name; description; argumentHint?; kind: "prompt"; template: string } | { name; description; kind: "action"; action: "compact" | "context" | "rewind" | "plan" | "help" }`. Write the five prompt templates in full — each 5–15 lines, imperative, referencing `$ARGUMENTS` where sensible (e.g. `/commit $ARGUMENTS` = extra instructions). PASS, commit.

**Commit** — `feat(daemon): ten built-in slash commands`

### Task 9: Convex catalog + composer autocomplete

**Files:**
- Modify: `convex/schema.ts`: new table `slashCommands` — `{ argumentHint: v.optional(v.string()), description: v.string(), machineId: v.id("machines"), name: v.string(), projectId: v.optional(v.id("projects")), scope: v.union(v.literal("builtin"), v.literal("project"), v.literal("user"), v.literal("skill")) }` with index `by_project` on `["projectId"]` and `by_machine` on `["machineId"]`
- Create: `convex/slash_commands.ts` — `publishCatalog` mutation (device-token auth; replace-all for the machine/project pair, idempotent) and `listForThread` query (user auth; resolves thread → project → commands, ordered builtin → project → user)
- Test: `convex/slash_commands.convex.test.ts`
- Modify: `apps/daemon/src/relay-client.ts` — add `publishCommandCatalog`; call it at daemon startup and after each project claim (catalog = built-ins + loaded commands for that project's trust state)
- Modify: `apps/web/src/composer.tsx` + `apps/web/src/composer.test.tsx` — autocomplete
- Modify: `apps/web/src/thread-view.tsx` (~line 272) — pass `commands` prop from a `useQuery(api.slash_commands.listForThread, …)`

**Composer behavior to pin with failing component tests first:**
1. Typing `/` as the first character opens a dropdown listing commands (name, description, argument hint), filtered by prefix as the user types.
2. Arrow keys + Enter select (Enter with dropdown open selects, does not submit); Escape closes; Tab completes.
3. Selection inserts `/name ` into the textarea; message submits through the existing `onSubmit` unchanged — **the raw `/name args` text is what gets sent**; all expansion is daemon-side.
4. Dropdown highlight is patina (interactive), never brass.

Implement dropdown as part of `Composer` (new optional `commands` prop, default `[]` so existing tests keep passing). PASS, `bun run typecheck`.

**Commit** — `feat: slash command catalog published to Convex + composer autocomplete`

### Task 10: Daemon-side expansion + action dispatch

**Files:**
- Modify: `apps/daemon/src/agent-loop.ts` — at the claim site (after `claimQueuedMessage`, before `buildTurnPrompt` ~line 75)
- Test: extend `apps/daemon/src/agent-loop.test.ts` (fixture patterns already exist there)

**Behavior to pin with failing tests first:**
1. Claimed content `/fix-issue 123` where `fix-issue` is a loaded command → the prompt passed to the turn is the expanded template; the stored user message stays `/fix-issue 123` (history shows what the user typed).
2. Unknown `/nope` → turn proceeds with the literal text (models handle it; matches Claude Code behavior).
3. Prompt built-in (e.g. `/init`) → expanded template turn.
4. Action built-in `/help` → daemon appends an assistant message listing the catalog (via `gateway.appendAssistantText` + `completeAssistantMessage`) **without** invoking the turn provider.
5. Action `/plan` → calls the existing plan-phase mutation; action `/rewind` → invokes the existing checkpoint-restore path (see `checkpoints.ts` / `checkpoint-worker.ts`); both then complete the message with a confirmation line.
6. Per-command `model` frontmatter overrides the turn's `modelId` for that turn only (plumb through the existing `modelId` plumbing in the claim response).

`/compact` and `/context` dispatch to functions created in Task 11 — stub them here (`throw new Error("not implemented")`) and mark the two dispatch tests `.todo` until Task 11.

**Commit** — `feat(daemon): slash expansion and action dispatch in claim path`

### Task 11: `/context` and `/compact` actions

**Files:**
- Create: `apps/daemon/src/context-actions.ts` + test
- Modify: `convex/conversations.ts` — add `compactHistory` mutation (device-token auth): inserts a summary message flagged `kind: "compaction"` and marks prior messages excluded from the `history` array returned by `claimQueuedMessage` (widen `messages` schema with optional `compactedAt: v.number()` / `kind` field as needed — check the existing messages table shape at `convex/schema.ts:86` first)
- Modify: dispatch stubs from Task 10

**Behavior (failing tests first):**
- `/context`: estimate tokens from the claimed `history` (chars/4 heuristic — same estimator the context policy uses; reuse it if exported from `packages/harness-runtime`, otherwise inline) plus system-prompt size; append an assistant message with a breakdown table (system prompt / project instructions / history / skills catalog) and percentage of the active model's window (from `packages/shared/src/model-catalog.ts`).
- `/compact`: run a summarization turn via the existing `turnProvider.streamReply` with a fixed summarization prompt over the history, then call `compactHistory` with the summary. Next claim's `history` = summary + messages after compaction point. Un-mark the `.todo` tests from Task 10.

**Commit** — `feat: manual /compact and /context actions`

---

## Phase 4: Skills

### Task 12: Skill loader

**Files:**
- Create: `apps/daemon/src/skills.ts` + `apps/daemon/src/skills.test.ts`

Format: `<root>/skills/<name>/SKILL.md` (Agent Skills standard — same as Claude Code and Pi). Frontmatter: `name` (defaults to directory name), `description` (required — skip skills without one, warn). Caps: description ≤ 500 chars, body ≤ 32KB, ≤ 50 skills.

**Failing tests:** load from nested dirs at both scopes; project shadows user; missing description → skipped; returns `{ name, description, scope, directory, body }`. Implement with `resolveExtensionRoots({ kind: "skills", … })`. PASS.

**Commit** — `feat(daemon): SKILL.md loader`

### Task 13: Skills in the system prompt + `skill` tool

**Files:**
- Modify: `packages/shared/src/tools.ts:9` — widen tool enum with `"skill"` (and `"todo"`, `"bash_output"` now, one widen instead of three; update `toolEventSchema` consumers that exhaustively match)
- Modify: `apps/daemon/src/tool-executor.ts` — new `ToolCall` variant `{ kind: "skill"; name: string }`; executor returns the skill body prefixed with `Skill directory: <dir>` (so relative file references inside the skill resolve)
- Modify: `apps/daemon/src/tool-descriptions.ts` — description: "Load a skill's full instructions. Invoke when the current task matches a skill's description."
- Modify: `apps/daemon/src/policy.ts` — classify `skill` as capability `read`, risk low
- Modify: `apps/daemon/src/system-prompt.ts` — new block when skills exist: `AVAILABLE SKILLS:` followed by `- name: description` lines and the instruction "If a skill matches the task, call the skill tool before answering."
- Modify: `apps/daemon/src/agent-loop.ts` / turn wiring — pass loaded skills into `buildSystemPrompt` and expose the tool only when skills exist
- Tests: extend `tool-executor.test.ts`, `policy.test.ts`, `system-prompt` tests

**TDD order:** widen schema (typecheck-driven — fix every exhaustive match the compiler flags), then failing executor test (skill tool returns body), then failing system-prompt test (catalog block present iff skills exist), then policy test. All PASS, `bun run typecheck` clean.

**Commit** — `feat: skill tool + system-prompt catalog, governed as read`

### Task 14: Skills as slash commands

**Files:**
- Modify: `apps/daemon/src/relay-client.ts` catalog publishing (Task 9) — include skills as `scope: "skill"` entries named `skill:<name>`
- Modify: Task 10 dispatch — `/skill:<name> args` expands to: `Load the "<name>" skill with the skill tool and follow it for this task: $ARGUMENTS`

Failing test in `agent-loop.test.ts` first; implement; PASS.

**Commit** — `feat: /skill:name invocation via composer`

---

## Phase 5: Hooks

### Task 15: Hook config + runner

**Files:**
- Create: `apps/daemon/src/hooks.ts` + `apps/daemon/src/hooks.test.ts`
- Modify: `apps/daemon/src/tools.ts` `runCommand` — add optional `stdin?: string` (pass via `Bun.spawn`'s `stdin: "pipe"` and write+end; failing test first in `tools.test.ts`)

Config: `hooks` key in `<daemonHome>/settings.json` (user) and `.relay/settings.json` (project, trust-gated):

```json
{
  "hooks": {
    "PreToolUse":  [{ "matcher": "bash", "command": "./scripts/check.sh", "timeout": 30000 }],
    "PostToolUse": [{ "matcher": "edit|str_replace", "command": "bun run format --stdin-filepath" }],
    "TurnStart":   [{ "command": "echo turn-start" }],
    "TurnEnd":     [{ "command": "echo turn-end" }]
  }
}
```

Zod-validate; invalid config → warn and skip that file, never crash. `matcher` is a regex over the tool kind; omitted = match all.

**Runner contract (failing tests first, use real `bash -c` scripts in temp dirs):**
- Input: JSON on stdin `{ event, threadId, tool, summary, toolInput }` (`toolInput` = the `ToolCall`, credential-redacted via the existing `summarizeToolCall`/`redactCredentials` helpers).
- Exit 0 → allow (PostToolUse/TurnEnd: fire-and-forget, log stderr).
- Exit 2 on PreToolUse → **deny**; stderr becomes the refusal feedback shown to the model.
- Other exit codes / timeout (default 30s) → log warning, allow (hooks fail open on error, fail closed only on explicit exit 2 — matches Claude Code semantics).
- Hooks run sequentially per event; first deny wins.

**Commit** — `feat(daemon): lifecycle hook config and runner`

### Task 16: Wire hooks into the chokepoint

**Files:**
- Modify: `apps/daemon/src/governed-tool-executor.ts` — new optional param `hooks?: HookRunner`. After policy allows (or approval granted), run `PreToolUse`; deny → `governance.recordDecision({ decision: "deny", … })` with summary `hook: <command>` and return `{ kind: "refused", output }` including the hook's stderr. After successful execution, run `PostToolUse` (non-blocking).
- Modify: `apps/daemon/src/agent-loop.ts` — construct the `HookRunner` per claim (project scope only when trusted) and pass it through; fire `TurnStart` before the first provider call and `TurnEnd` after `completeAssistantMessage`.
- Tests: extend `governed-tool-executor.test.ts` — (a) exit-2 PreToolUse hook blocks a bash call and the refusal reaches the model; (b) hook denial lands in the audit log; (c) PostToolUse receives the executed tool's summary; (d) no hooks configured → behavior byte-identical to today.

**Commit** — `feat: hooks enforced at the governance chokepoint, audited`

---

## Phase 6: Todo tool

### Task 17: Todo tool + Convex state

**Files:**
- Modify: `apps/daemon/src/tool-executor.ts` — variant `{ kind: "todo"; items: Array<{ content: string; status: "pending" | "in_progress" | "completed" }> }`; executor calls a new `onTodo` callback and returns `"Todo list updated (N items)"`
- Modify: `apps/daemon/src/tool-descriptions.ts` — "Maintain the turn's task list. Rewrite the whole list each call. Exactly one item in_progress at a time. Use for tasks with 3+ steps."
- Modify: `apps/daemon/src/policy.ts` — capability `read` (state-only, never needs approval)
- Modify: `convex/schema.ts` — table `todos`: `{ items: v.array(v.object({ content: v.string(), status: v.union(v.literal("pending"), v.literal("in_progress"), v.literal("completed")) })), threadId: v.id("threads"), updatedAt: v.number() }`, index `by_thread`
- Create: `convex/todos.ts` — `update` mutation (device-token, upsert by thread, cap 50 items) + `getForThread` query (user auth)
- Modify: `apps/daemon/src/relay-client.ts` + `agent-loop.ts` — wire `onTodo` → `todos:update`
- Modify: `apps/daemon/src/system-prompt.ts` — one behavioral-rules line: "For multi-step tasks, maintain a todo list with the todo tool and keep it current."
- Tests: executor test, convex test, wiring test in `agent-loop.test.ts`

**Commit** — `feat: todo tool with per-thread Convex state`

### Task 18: Todo panel in the web app

**Files:**
- Create: `apps/web/src/todo-panel.tsx` + `apps/web/src/todo-panel.test.tsx`
- Modify: `apps/web/src/thread-view.tsx` — render above the composer while the thread is running and todos exist

**Failing tests:** renders items in order; `completed` = strikethrough + check glyph, `in_progress` = neutral bold emphasis (NOT brass, NOT patina — this is progress, not needs-you and not chrome), `pending` = muted; collapses to a one-line `3/7 done · current: <item>` summary bar, expandable (expand affordance is patina). Subscribe via `useQuery(api.todos.getForThread, …)`. Match density/typography of `thread-activity.tsx`.

**Commit** — `feat(web): todo progress panel`

---

## Phase 7: Background bash

### Task 19: Background shell manager

**Files:**
- Create: `apps/daemon/src/background-shells.ts` + `apps/daemon/src/background-shells.test.ts`

**Contract (failing tests first — real `Bun.spawn` with short scripts):**
- `start({ command, platform, root }) → { shellId }` — spawns via the existing `shellInvocation`, detached from the turn.
- `read({ shellId }) → { exited: boolean; exitCode?: number; output: string }` — returns output accumulated **since the last read** (cursor per shell), ring-buffered at 200KB.
- `kill({ shellId })` — SIGKILL, marks exited.
- `drainExitNotifications() → string[]` — human-readable lines ("Background shell abc123 (`bun run dev`) exited with code 0") for shells that exited since the last drain.
- Hard caps: 8 concurrent background shells (start fails with a clear error), all killed on daemon shutdown (wire into the daemon's existing shutdown path in `apps/daemon/src/index.ts`).

**Commit** — `feat(daemon): background shell manager`

### Task 20: Wire background bash into tools + turns

**Files:**
- Modify: `apps/daemon/src/tool-executor.ts` — `bash` variant gains `background?: boolean` (starts shell, returns `{ shellId, note: "running in background — poll with bash_output" }`); new variants `{ kind: "bash_output"; shellId: string }` and `{ kind: "kill_shell"; shellId: string }`
- Modify: `packages/shared/src/tools.ts` enum (add `"kill_shell"`; `"bash_output"` was added in Task 13)
- Modify: `apps/daemon/src/tool-descriptions.ts` — bash: "Set background: true for long-running processes (dev servers, watchers). Never background short commands."; descriptions for the two new tools
- Modify: `apps/daemon/src/policy.ts` — background bash classifies exactly like bash (exec; same risk tiers); `bash_output` = read; `kill_shell` = exec/low
- Modify: `apps/daemon/src/agent-loop.ts` — at the steering-context injection point (~line 179), append `drainExitNotifications()` lines so the model learns about exits on its next iteration; also drain at the start of each newly claimed turn
- Tests: executor + policy + an agent-loop test proving an exit notification reaches the next turn's prompt

**Commit** — `feat: background bash with output polling and exit notifications`

---

## Phase 8: End-to-end wiring verification

### Task 21: Full verification pass

No new code — prove everything is wired and configured.

1. `bun run typecheck` — clean.
2. `bun run test` — all green (root runs every workspace).
3. `bun run build` — clean.
4. `bun run convex:dev` — schema and functions push without validator errors; confirm new tables (`slashCommands`, `todos`) and widened fields appear in the dashboard.
5. Manual E2E with the project's `/verify` skill (build/launch/drive recipe): pair, start daemon, then in the browser:
   - a repo with `.relay/commands/echo-test.md` triggers the **brass trust card**; trusting it makes `/echo-test` appear in composer autocomplete and expand correctly
   - `/help`, `/context`, `/plan` action commands respond without a model turn
   - a `.relay/skills/demo/SKILL.md` shows in the system prompt catalog and loads via the skill tool when prompted
   - a `PreToolUse` exit-2 hook blocks a bash call and the denial shows in the governance panel / audit log
   - a multi-step prompt produces a live-updating todo panel
   - `bash` with `background: true` starts a dev server; `bash_output` polls it; exit notification appears next turn
6. Characterization guard: `apps/daemon/src/legacy-runtime.characterization.test.ts` still passes — the legacy vertical slice is unchanged for users with no extensions configured.
7. Update `README.md` (new `.relay/` layout, built-in commands table) and `CONTEXT.md` glossary (trust gate, slash command, skill, hook, todo, background shell).

**Commit** — `docs: extensibility layer documented; verification pass complete`

---

## Phase 9: Provider & model directory (models.dev)

Replace the hand-maintained 4-model `packages/shared/models.json` with a live directory from `https://models.dev/api.json` (verified live 2026-07-18: 167 providers; treat all counts and optional fields as time-sensitive), add per-provider credentials (API key via CLI, subscription via OAuth device/PKCE flows), and gate the composer model dropdown to providers that actually have credentials. **Grouping and visual organization of the dropdown stay exactly as they are** (`groupModelsByProvider`).

**Hard constraints for this phase:**
- **Secrets never transit Convex.** API keys are entered on the machine (CLI) and stored in the daemon home with `0600`. The browser only ever sees connection *status* and OAuth verification URLs.
- The upstream payload (~3.1MB) never ships to the browser. The daemon normalizes and publishes only enabled models of connected providers.
- The upstream schema is tolerant-parsed: every field optional unless proven required against the live payload at implementation time. **Before Task 22, fetch `https://models.dev/api.json` and inspect the actual field names** (esp. `cost` and `limit` sub-keys) — do not trust this plan's memory of them.
- Static `MODEL_CATALOG` remains as the offline/first-run fallback everywhere; nothing may break when the directory is unreachable or the Convex projection is empty.

### Task 22: Directory adapter in `@relay/shared`

**Files:**
- Create: `packages/shared/src/model-directory.ts`
- Test: `packages/shared/src/model-directory.test.ts`
- Create: `packages/shared/models-dev-fixture.json` (a trimmed real slice of the live payload — 3 providers, ~6 models — captured at implementation time; this is the test fixture AND documents the observed upstream shape)
- Modify: `packages/shared/src/index.ts` (export)

**Failing tests first (against the fixture):**
1. `parseDirectory(json)` tolerant-parses: unknown fields ignored, providers with missing/malformed models skipped with a warning list, never throws on real payload shape.
2. `normalizeDirectory({ directory, apiKindOverrides })` produces `CatalogModel[]` that passes the existing `catalogModelSchema`, with:
   - `id` = `provider/model` (matches Relay's existing convention)
   - **apiKind mapping**: override table `{ anthropic: "anthropic-messages", openai: "openai-responses" }`, default `"openai-completions"` (OpenAI-compatible is the aggregator norm; the `npm` field is a hint only)
   - **thinking map**: models.dev `reasoning_options` effort values normalized onto Relay's `none/low/medium/high` (`none: null` always; map `low→low`, `medium→medium`, `high→high`; extra upstream values like `xhigh`/`max` collapse to `high`); non-reasoning models get `{ none: null }`
   - `cost` and context/output limits mapped from the verified upstream field names; models missing cost data get zeros (usage panel already tolerates zero-cost entries — verify in `packages/shared/src/usage.ts`)
   - **computed fallbacks** (replaces hand-authored chains): same `family` sibling within the provider (newest `release_date` first), else empty — no cross-provider fallbacks from the directory
3. Deprecated/retired lifecycle-status models are excluded from normalization output.

Implement, PASS, `bun run typecheck`. **Commit** — `feat(shared): models.dev directory adapter with tolerant schema`

### Task 23: Daemon directory service with TTL cache

**Files:**
- Create: `apps/daemon/src/model-directory-service.ts` + test

**Contract (failing tests with a fake fetcher, temp daemon home):**
1. `getCatalog()` fetches `https://models.dev/api.json`, normalizes via Task 22, writes `<daemonHome>/model-directory.json` (`{ fetchedAt, payload }`), returns the merged catalog (directory models + static `MODEL_CATALOG` models not shadowed by directory entries, so existing model IDs keep resolving).
2. Within a 24h TTL, no refetch (fake clock).
3. Fetch failure → cached snapshot; no cache → static `MODEL_CATALOG` alone. Never throws; logs a warning.
4. `refresh()` forces a refetch (used by the settings UI's refresh action later).

**Commit** — `feat(daemon): model directory service with 24h cache and static fallback`

### Task 24: Provider credential store + `relay auth` CLI

**Files:**
- Create: `apps/daemon/src/provider-credentials.ts` + test
- Modify: `apps/daemon/src/cli.ts` (`parseCli` union at lines 10–13 gains `{ command: "auth"; subcommand: "login" | "logout" | "list"; provider?: string }`; follow the existing `project` subcommand parsing pattern at lines 36–56)
- Test: extend `apps/daemon/src/cli.test.ts`

**Credential store contract (failing tests first):**
1. File `<daemonHome>/provider-credentials.json`, written with mode `0600` (assert with `stat`), atomic write (temp + rename, same pattern as Task 3's trust store).
2. Records: `{ [providerId]: { type: "api_key"; key: string } | { type: "oauth"; issuer: string } }` (OAuth tokens themselves live in the existing `FileOAuthTokenStore` from `apps/daemon/src/mcp-oauth.ts:108` — reuse it, keyed by issuer; do not invent a second token store).
3. `resolveSecrets({ catalog, credentials, env })` precedence: env var wins → stored api_key → live OAuth access token. Env var names come from the directory's per-provider `env` field (e.g. `ANTHROPIC_API_KEY`) **plus** the existing `RELAY_<PROVIDER>_API_KEY` names from `apps/daemon/src/model-router.ts:24-26` (backward compatible — pin with a test).

**CLI behavior:** `relay auth login <provider>` prompts for the key with echo off (Bun: `process.stdin` raw mode; test the parse + store call, not the TTY), validates the provider exists in the directory, saves. `logout` removes; `list` prints provider, source (env/api_key/oauth), and masked tail. Update the `help` text.

**Commit** — `feat(daemon): provider credential store and relay auth CLI`

### Task 25: Subscription OAuth flows

**Files:**
- Create: `apps/daemon/src/provider-oauth.ts` + test

Generalize the machinery already in `apps/daemon/src/mcp-oauth.ts` (PKCE client, `beginAuthorization()` returning `{ authorizationUrl, completion }`, `FileOAuthTokenStore`, refresh-on-expiry):

1. `PROVIDER_OAUTH_CONFIGS`: a table of per-provider flow configs, shipping initially with `anthropic` (subscription PKCE flow) and `github-copilot` (device-code flow). Each config: flow kind (`pkce` | `device_code`), endpoints, client id, scopes. **Verify the current endpoint values upstream at implementation time** — they change; cite the source in a code comment.
2. `beginProviderLogin(providerId)` → `{ verificationUrl, userCode?, completion: Promise<void> }`. Device-code flow polls the token endpoint at the server-given interval; PKCE reuses the localhost-redirect pattern from `McpOAuthClient.beginAuthorization` (mcp-oauth.ts:62).
3. On completion, tokens land in the shared `FileOAuthTokenStore` and the credential store records `{ type: "oauth", issuer }`.
4. `relay auth login <provider>` uses OAuth automatically when the provider has a config and no `--key` flag was passed; prints the verification URL + user code.
5. Failing tests with fake fetch: device-code happy path, polling `authorization_pending` → success, token refresh via the existing refresh path.

**ToS note (product requirement, not code):** subscription OAuth from third-party harnesses is tolerated-but-gray for some providers. The settings UI (Task 29) must label these flows "uses your existing subscription — subject to the provider's terms" rather than presenting them as officially supported.

**Commit** — `feat(daemon): subscription OAuth login flows (anthropic, github-copilot)`

### Task 26: Availability + catalog projection to Convex

**Files:**
- Modify: `convex/schema.ts` — two new tables:
  - `providerStatus`: `{ connectedAt: v.number(), machineId: v.id("machines"), providerId: v.string(), providerName: v.string(), source: v.union(v.literal("env"), v.literal("api_key"), v.literal("oauth")) }`, index `by_machine`
  - `machineModels`: `{ apiKind: v.string(), contextWindow: v.optional(v.number()), machineId: v.id("machines"), modelId: v.string(), name: v.string(), providerId: v.string(), thinking: v.any(), … }` — mirror the `CatalogModel` fields the web actually renders; index `by_machine`
- Create: `convex/providers.ts` — `publishStatus` mutation (device-token auth, replace-all per machine: statuses + enabled models in one call, ≤ 200 models hard cap) and `listForMachine` query (user auth: statuses + models)
- Test: `convex/providers.convex.test.ts`
- Modify: `apps/daemon/src/relay-client.ts` — add `publishProviderStatus`; call at daemon startup and after every `relay auth` change (auth CLI touches the store → daemon republishes on next heartbeat; pin with a test that the startup path publishes)

Read `convex/_generated/ai/guidelines.md` before writing; follow the auth patterns of `convex/slash_commands.ts` (Task 9). Failing tests: replace-all semantics, device-token rejection, query joins statuses + models.

**Commit** — `feat(convex): provider status and per-machine model catalog projection`

### Task 27: Router honors the credential store + dynamic catalog

**Files:**
- Modify: `apps/daemon/src/model-router.ts` — `resolveProviderConfig` takes the generalized secrets from Task 24's `resolveSecrets` instead of the three hardcoded env checks (lines 24–26); keep the function signature backward compatible by accepting an optional `credentials` param defaulting to empty
- Modify: `apps/daemon/src/catalog-provider-router.ts` — `LocalModelRouter` takes `catalog` from the directory service (Task 23) instead of static `MODEL_CATALOG`, and the credential store; OAuth-sourced providers get a token that is refresh-checked at resolve time (reuse the refresh path from mcp-oauth)
- Modify: daemon composition root (`apps/daemon/src/index.ts` / `kernel-daemon.ts` wiring) — construct directory service + credential store once, inject into the router and the projection publisher
- Tests: extend `model-router.test.ts` + `catalog-provider-router.test.ts` — (a) stored api_key resolves a provider that has no env var; (b) env var still wins over stored key; (c) a directory model absent from static models.json resolves end-to-end; (d) `resolveCatalogModel` fallback chains still work with computed fallbacks

**Commit** — `feat(daemon): model routing over dynamic catalog and credential store`

### Task 28: Curation — enabled models per provider

Connecting an aggregator (OpenRouter has hundreds of models) must not flood the dropdown.

**Files:**
- Create: `apps/daemon/src/enabled-models.ts` + test
- Modify: the publish path from Task 26 to filter through it

**Contract (failing tests first):**
1. Daemon settings file (`<daemonHome>/settings.json`, same file as hooks config, key `enabledModels`): `{ [providerId]: string[] | "all" | "default" }` (absent = `"default"`).
2. `"default"` = the provider's models with `tool_call: true`, excluding deprecated, sorted by `release_date` desc, **capped at 6 per provider**.
3. `"all"` = everything non-deprecated (the cap in Task 26's mutation still applies); explicit array = exactly those IDs (unknown IDs warn + skip).
4. Models named by any thread's current `modelId` are always included even if not enabled (open threads must not lose their model).

**Commit** — `feat(daemon): enabled-models curation with sane per-provider defaults`

### Task 29: Web — gated picker + Providers & Models settings

**Files:**
- Create: `apps/web/src/use-model-catalog.ts` + test — hook returning `{ models, source }`: `useQuery(api.providers.listForMachine, …)` when non-empty, else static `MODEL_CATALOG.models` (offline/dev fallback). This is the **single seam** for the web catalog.
- Modify: `apps/web/src/model-utils.ts` — `groupModelsByProvider` unchanged (the organization the user wants kept); only its input becomes the hook's models
- Modify: `apps/web/src/model-picker.tsx` (lines 2, 21, 49), `apps/web/src/reasoning-variant-picker.tsx:33`, `apps/web/src/plan-panel.tsx:25-26`, `apps/web/src/settings-view.tsx:67,102` — replace direct `MODEL_CATALOG` reads with the hook (components accept `models` as a prop with the static default, so existing component tests keep passing unchanged; pin that with a test)
- Modify: `apps/web/src/settings-view.tsx` — the existing `"models"` section (`SettingsSection` union at line 8 already has it) becomes **Providers & Models**:
  - **Connected** list: provider name, logo (`https://models.dev/logos/{providerId}.svg`, with text fallback if the image errors — note: external image, check the web app's CSP config in `apps/web` allows it or fall back to text-only), source badge (env / API key / subscription), enabled-model count
  - **Available** list (rest of the directory — needs a slim `providerDirectory` summary published in Task 26's mutation: `{ providerId, providerName, modelCount }` only, NOT the full payload): each row shows the copyable CLI line `relay auth login <provider>` and, for OAuth-capable providers, a "Sign in with subscription" affordance + the ToS-gray label from Task 25
  - OAuth from the browser: clicking "Sign in" enqueues a `provider.login` request via the existing command-inbox/worker pattern (`convex/commands/inbox.ts` + `apps/daemon/src/command-worker.ts`); the daemon starts the flow and surfaces `{ verificationUrl, userCode }` back as a **brass needs-you card** (reuse the `mcp_elicitations` card pattern — `apps/web/src/mcp-elicitation-card.tsx`); completing it flips the provider to Connected reactively
- Tests: `use-model-catalog.test.ts`, extended `model-picker.test.tsx` (picker shows only published providers when projection non-empty; grouping/order/captions byte-identical otherwise), `settings-view.test.tsx` (three states: connected, available, oauth-pending)

**Picker rule pinned by test:** when the projection is empty (daemon offline, fresh deploy), the picker falls back to the full static catalog — never an empty dropdown. Interactive affordances patina; the OAuth pending card brass; per ADR 0004.

**Commit** — `feat(web): credential-gated model picker and provider directory settings`

### Task 30: Phase 9 verification

1. `bun run typecheck && bun run test && bun run build` — green.
2. `bun run convex:dev` — `providerStatus` + `machineModels` tables appear.
3. Manual E2E (project `/verify` skill):
   - Fresh daemon, no keys: picker shows the static catalog; settings shows the full directory as Available, nothing Connected.
   - `relay auth login deepseek` (API key): daemon republishes; picker now shows **only** deepseek models, grouped exactly as before; other providers gone from the dropdown but present in settings.
   - Set `ANTHROPIC_API_KEY` in the daemon env: anthropic appears without any stored credential (env precedence).
   - Browser "Sign in with subscription" for a configured OAuth provider: brass card with verification URL appears, completing it flips the provider to Connected and its models into the picker.
   - Kill network, restart daemon: cached directory serves; delete cache too: static fallback serves. No crash in either case.
   - A thread already pinned to a model of a now-disconnected provider still renders its model name (Task 28 rule 4).
4. Update `README.md` (auth CLI, provider settings) and `CONTEXT.md` glossary (model directory, provider credential, enabled models, availability projection).

**Commit** — `docs: provider directory documented; phase 9 verification complete`

---

## Explicitly deferred (do not build now — YAGNI)

- Plugins/packages bundling (needs 1–4 shipped first), LSP diagnostics, session forking/branching UI, user-definable subagent files, grep/glob first-class tools, kernel-mode ports of these features (kernel adopts them at cutover via the same seams: `resolveExtensionRoots`, `HookRunner`, `BackgroundShellManager` are all runtime-agnostic modules).
