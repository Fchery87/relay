# Relay Competitive Upgrade Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make Relay's permission system real (including a Claude Code–style yolo mode), unlock multi-project management at runtime, and replace the single-shot tool phase with a true agentic loop with history, system prompt, and a competitive tool surface.

**Architecture:** Six phases, ordered by dependency and risk. Phases 1–2 are independent product features (yolo mode, multi-project) touching Convex + daemon + web. Phases 3–6 rebuild the engine: native tool_use/tool_result loop in `turn-loop.ts`, thread history + system prompt, upgraded tools (str_replace edit, grep/glob, bounded read, bash timeout), then prompt caching and provider resilience. The legacy two-phase loop (`toolCalls` + `streamReply`) is deleted at the end of Phase 3.

**Tech Stack:** Bun + TypeScript (daemon), Convex (backend, `convex-test` + vitest), React/Vite (web), zod. Daemon tests use `bun:test` (`cd apps/daemon && bun test`). Convex tests: `cd convex && bun run test:convex`. Full suite: `bun run test` at repo root. Typecheck: `bun run typecheck`.

**Key facts discovered during research (do not re-derive):**
- Threads already carry `permissionProfile` (`"read-only" | "workspace-write" | "full-access"`, `convex/schema.ts:58`) and the web `AccessPicker` (`apps/web/src/composer.tsx:91`) already sets it — but the daemon never reads it. `claimQueuedMessage` (`convex/conversations.ts:171`) does not return it.
- Daemon policy comes from `policy.json` via `RELAY_POLICY_PATH` (`apps/daemon/src/index.ts:55`) and is static per-daemon.
- Projects are already many-per-machine (`convex/schema.ts:25`, sidebar renders groups) but are only registered from the `RELAY_PROJECTS` env var at daemon startup (`apps/daemon/src/config.ts:36`). `registerMachine` **hard-deletes** unregistered project rows (`convex/machines.ts:54-58`), orphaning threads.
- The "agentic loop" is single-shot: one non-streaming request for tool calls (`model-provider.ts:87-93`), blind execution, then a separate `streamReply` with results pasted as XML (`agent-loop.ts:126-172`). No history, no system prompt (`model-router.ts:43-79`).

---

## Phase 1: Enforced permission profiles + Yolo mode

Make the thread-level `permissionProfile` actually govern the daemon, and add `relay start --yolo` (alias `--dangerously-skip-permissions`) that bypasses all approvals, Claude Code–style. Yolo wins over thread profiles. Audit logging is preserved (allow decisions are still recorded via `governance.recordDecision`). Plan-mode's read-only turn gating stays even in yolo.

### Task 1: `effectivePolicy` in policy.ts

**Files:**
- Modify: `apps/daemon/src/policy.ts`
- Test: `apps/daemon/src/policy.test.ts`

**Step 1: Write the failing tests** (append to `policy.test.ts`):

```ts
import { ALLOW_ALL_POLICY, effectivePolicy } from "./policy";

test("full-access profile and yolo mode allow every capability at every risk", () => {
  for (const derived of [
    effectivePolicy({ base: policy, profile: "full-access", yolo: false }),
    effectivePolicy({ base: policy, profile: "workspace-write", yolo: true }),
    effectivePolicy({ base: policy, profile: "read-only", yolo: true }),
  ]) {
    expect(evaluatePolicy({ capability: "exec", policy: derived, risk: "critical" })).toBe("allow");
    expect(evaluatePolicy({ capability: "edit", policy: derived, risk: "low" })).toBe("allow");
    expect(evaluatePolicy({ capability: "task", policy: derived, risk: "high" })).toBe("allow");
  }
});

test("read-only profile denies mutation but keeps reads and search", () => {
  const derived = effectivePolicy({ base: policy, profile: "read-only", yolo: false });
  expect(evaluatePolicy({ capability: "read", policy: derived, risk: "low" })).toBe("allow");
  expect(evaluatePolicy({ capability: "search", policy: derived, risk: "low" })).toBe("allow");
  expect(evaluatePolicy({ capability: "read", policy: derived, risk: "critical" })).toBe("ask");
  expect(evaluatePolicy({ capability: "edit", policy: derived, risk: "low" })).toBe("deny");
  expect(evaluatePolicy({ capability: "exec", policy: derived, risk: "low" })).toBe("deny");
});

test("workspace-write profile without yolo returns the base policy unchanged", () => {
  expect(effectivePolicy({ base: policy, profile: "workspace-write", yolo: false })).toBe(policy);
});
```

**Step 2: Run tests, verify failure**

Run: `cd apps/daemon && bun test src/policy.test.ts`
Expected: FAIL — `effectivePolicy` is not exported.

**Step 3: Implement** (append to `policy.ts`):

```ts
export const permissionProfileSchema = z.enum(["read-only", "workspace-write", "full-access"]);
export type PermissionProfile = z.infer<typeof permissionProfileSchema>;

const ALL_CAPABILITIES = capabilitySchema.options;
const ALL_RISKS = riskSchema.options;

export const ALLOW_ALL_POLICY: Policy = {
  rules: ALL_CAPABILITIES.flatMap((capability) => ALL_RISKS.map((risk) => ({ capability, decision: "allow" as const, risk }))),
};

const READ_ONLY_POLICY: Policy = {
  rules: [
    { capability: "read", decision: "allow", risk: "low" },
    { capability: "read", decision: "allow", risk: "high" },
    { capability: "read", decision: "ask", risk: "critical" },
    ...ALL_RISKS.map((risk) => ({ capability: "search" as const, decision: "allow" as const, risk })),
  ],
};

export function effectivePolicy({ base, profile, yolo }: { base: Policy; profile: PermissionProfile; yolo: boolean }): Policy {
  if (yolo || profile === "full-access") return ALLOW_ALL_POLICY;
  if (profile === "read-only") return READ_ONLY_POLICY;
  return base;
}
```

**Step 4: Run tests, verify pass.** `cd apps/daemon && bun test src/policy.test.ts` → PASS.

**Step 5: Commit** — `git add apps/daemon/src/policy.ts apps/daemon/src/policy.test.ts && git commit -m "feat(daemon): derive effective policy from permission profile and yolo flag"`

### Task 2: Return `permissionProfile` from `claimQueuedMessage`

**Files:**
- Modify: `convex/conversations.ts:171-207` (the `claimQueuedMessage` return object)
- Test: `convex/conversations.convex.test.ts`

**Step 1: Failing test** (append; mirror the existing claim tests in that file, using `createAuthenticatedProject` from `./test_helpers`):

```ts
test("claimQueuedMessage returns the thread permission profile", async () => {
  const t = convexTest(schema, modules);
  const { deviceToken, projectId } = await createAuthenticatedProject(t);
  const threadId = await t.run((ctx) => ctx.db.insert("threads", { permissionProfile: "full-access", projectId, status: "idle", title: "yolo" }));
  await t.run((ctx) => ctx.db.insert("messages", { content: "go", role: "user", status: "queued", threadId }));
  const claimed = await t.mutation(api.conversations.claimQueuedMessage, { deviceToken });
  expect(claimed).toMatchObject({ permissionProfile: "full-access", threadId });
});

test("claimQueuedMessage defaults permission profile to workspace-write", async () => {
  const t = convexTest(schema, modules);
  const { deviceToken, projectId } = await createAuthenticatedProject(t);
  const threadId = await t.run((ctx) => ctx.db.insert("threads", { projectId, status: "idle", title: "default" }));
  await t.run((ctx) => ctx.db.insert("messages", { content: "go", role: "user", status: "queued", threadId }));
  expect(await t.mutation(api.conversations.claimQueuedMessage, { deviceToken })).toMatchObject({ permissionProfile: "workspace-write" });
});
```

**Step 2: Run** `cd convex && bun run test:convex -- conversations` → FAIL (missing field).

**Step 3: Implement** — in the `claimQueuedMessage` return object (`convex/conversations.ts:189`), add one line:

```ts
        permissionProfile: thread.permissionProfile ?? "workspace-write",
```

**Step 4: Run tests → PASS.**

**Step 5: Commit** — `git commit -am "feat(convex): expose thread permission profile to the daemon claim"`

### Task 3: Enforce the profile in the agent loop

**Files:**
- Modify: `apps/daemon/src/agent-loop.ts` (`ConversationGateway.claimQueuedMessage` return type at line 13, `runQueuedTurn` at line 47, `runClaimedTurn` policy usage)
- Test: `apps/daemon/src/agent-loop.test.ts` (exists — follow its existing fake-gateway pattern)

**Step 1: Failing tests.** Using the file's existing fake gateway + `ScriptedModelProvider`:
- Test A: queued message with `permissionProfile: "full-access"`, scripted `{ kind: "bash", command: "rm -rf build" }` (high risk, base policy says "ask") → assert `governance.requestApproval` was **never called** and the command executed.
- Test B: `permissionProfile: "read-only"`, scripted edit call → assert tool result recorded as refusal (`policy_denied`) and no file written.
- Test C: `runQueuedTurn({ ..., yolo: true })` with `permissionProfile: "workspace-write"` and a critical exec (`sudo whoami`) → executed without approval.

**Step 2: Run** `cd apps/daemon && bun test src/agent-loop.test.ts` → FAIL.

**Step 3: Implement:**
1. Add `permissionProfile?: "read-only" | "workspace-write" | "full-access"` to the `claimQueuedMessage` return type (line 13) and the `queued` param type of `runClaimedTurn` (line 111).
2. Add `yolo?: boolean` to `runQueuedTurn`'s params.
3. In `runQueuedTurn`, before invoking `runClaimedTurn`:

```ts
  const turnPolicy = effectivePolicy({ base: policy, profile: queued.permissionProfile ?? "workspace-write", yolo: yolo ?? false });
```

and pass `policy: turnPolicy` through. Import `effectivePolicy` from `./policy`. Note `policyCapabilities(policy)` (line 258, subagent capability narrowing) must also receive `turnPolicy` so full-access threads can delegate all capabilities.
4. Do **not** touch `refusePlanningMutation` — plan-phase turns stay read-only regardless of profile/yolo.

**Step 4: Run tests → PASS.** Also `bun test` for the whole daemon package.

**Step 5: Commit** — `git commit -am "feat(daemon): enforce thread permission profiles and yolo override in turns"`

### Task 4: `relay start --yolo` CLI flag

**Files:**
- Modify: `apps/daemon/src/cli.ts`, `apps/daemon/src/index.ts`
- Test: `apps/daemon/src/cli.test.ts` (exists)

**Step 1: Failing tests:**

```ts
test("parses start --yolo and its long alias", () => {
  expect(parseCli(["start", "--yolo"])).toEqual({ command: "start", yolo: true });
  expect(parseCli(["start", "--dangerously-skip-permissions"])).toEqual({ command: "start", yolo: true });
  expect(parseCli(["start"])).toEqual({ command: "start", yolo: false });
  expect(parseCli([])).toEqual({ command: "start", yolo: false });
});
```

**Step 2: Run → FAIL** (current parser throws on any arg after `start`).

**Step 3: Implement:**
- `cli.ts`: change the start branch to accept optional `--yolo`/`--dangerously-skip-permissions`; type becomes `{ command: "start"; yolo: boolean }`. Pass through: `await (dependencies.runDaemon ?? runDaemon)({ yolo: command.yolo })`. Update `usage` string.
- `index.ts`: `runDaemon({ yolo = false }: { yolo?: boolean } = {})`. When yolo:
  - print `console.warn("⚠️  YOLO MODE: all permission checks are bypassed. Every tool call is auto-approved.")` right after connect;
  - pass `yolo` into the `runQueuedTurn` call (line 140);
  - pass `policy: ALLOW_ALL_POLICY` (import from `./policy`) into both `runQueuedSubagent` calls (lines 123, 131) and the `runQueuedCommand` call (line 188).
  - Also support `RELAY_YOLO=1` env: `const yoloMode = yolo || Bun.env.RELAY_YOLO === "1";`

**Step 4: Run** `cd apps/daemon && bun test` → PASS. `bun run typecheck`.

**Step 5: Commit** — `git commit -am "feat(daemon): add relay start --yolo permission bypass mode"`

### Task 5: Surface yolo/profile state in the web UI

**Files:**
- Modify: `apps/web/src/access-picker.tsx` (read it first — it already renders the three profiles)
- Test: `apps/web/src/access-picker.test.tsx`

**Step 1–4 (TDD):** Add a danger affordance to the `full-access` option: test asserts the full-access option renders with `aria-description` (or a `.access-danger` class) containing "auto-approves all tools". Implement with copy: `Full access — auto-approves all tools, including critical commands`. Match existing brass/patina styling conventions (see `docs/plans/2026-07-17-brass-and-patina-ui-overhaul.md`: patina = interactive, brass = needs-you).

**Step 5: Commit** — `git commit -am "feat(web): warn on full-access profile in access picker"`

---

## Phase 2: Multi-project management

Projects become runtime-managed: a `projects.json` in the daemon home (seeded from `RELAY_PROJECTS` once), `relay project add/remove/list` CLI, periodic re-sync to Convex, archival instead of hard-delete, and a web "Add project" flow where the daemon validates the path before activating.

### Task 6: Daemon project store

**Files:**
- Create: `apps/daemon/src/project-store.ts`
- Test: `apps/daemon/src/project-store.test.ts`

**Step 1: Failing tests** (use a temp dir via `mkdtemp` like `worktrees.test.ts` does):

```ts
import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addProject, listProjects, removeProject } from "./project-store";

test("seeds from env on first load and persists to projects.json", async () => {
  const daemonHome = await mkdtemp(join(tmpdir(), "relay-projects-"));
  const env = { RELAY_PROJECTS: JSON.stringify([{ name: "relay", path: "/repos/relay" }]) };
  expect(await listProjects({ daemonHome, env })).toEqual([{ name: "relay", path: "/repos/relay" }]);
  expect(await listProjects({ daemonHome, env: {} })).toEqual([{ name: "relay", path: "/repos/relay" }]); // persisted
});

test("add and remove round-trip and reject duplicates", async () => {
  const daemonHome = await mkdtemp(join(tmpdir(), "relay-projects-"));
  await addProject({ daemonHome, env: {}, name: "web", path: "/repos/web" });
  await expect(addProject({ daemonHome, env: {}, name: "dup", path: "/repos/web" })).rejects.toThrow("already registered");
  await removeProject({ daemonHome, env: {}, path: "/repos/web" });
  expect(await listProjects({ daemonHome, env: {} })).toEqual([]);
});
```

**Step 2: Run → FAIL** (module missing).

**Step 3: Implement** `project-store.ts`:

```ts
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { projectRegistrationSchema, type ProjectRegistration } from "@relay/shared";
import { z } from "zod";

const fileSchema = z.object({ projects: z.array(projectRegistrationSchema) });

function storePath(daemonHome: string): string {
  return join(daemonHome, "projects.json");
}

export async function listProjects({ daemonHome, env }: { daemonHome: string; env: Readonly<Record<string, string | undefined>> }): Promise<ProjectRegistration[]> {
  try {
    return fileSchema.parse(JSON.parse(await readFile(storePath(daemonHome), "utf8"))).projects;
  } catch {
    const seed = env.RELAY_PROJECTS ? z.array(projectRegistrationSchema).parse(JSON.parse(env.RELAY_PROJECTS)) : [];
    await save(daemonHome, seed);
    return seed;
  }
}

export async function addProject({ daemonHome, env, name, path }: { daemonHome: string; env: Readonly<Record<string, string | undefined>>; name: string; path: string }): Promise<void> {
  const projects = await listProjects({ daemonHome, env });
  if (projects.some((project) => project.path === path)) throw new Error(`${path} is already registered`);
  await save(daemonHome, [...projects, { name, path }]);
}

export async function removeProject({ daemonHome, env, path }: { daemonHome: string; env: Readonly<Record<string, string | undefined>>; path: string }): Promise<void> {
  await save(daemonHome, (await listProjects({ daemonHome, env })).filter((project) => project.path !== path));
}

async function save(daemonHome: string, projects: ProjectRegistration[]): Promise<void> {
  await writeFile(storePath(daemonHome), JSON.stringify({ projects }, null, 2), "utf8");
}
```

(Check `packages/shared` exports `ProjectRegistration`/`projectRegistrationSchema` — `config.ts:1` already imports the schema.)

**Step 4: Run → PASS. Step 5: Commit** — `git commit -m "feat(daemon): persistent project store in daemon home"`

### Task 7: Wire the store into config + `relay project` CLI

**Files:**
- Modify: `apps/daemon/src/config.ts` (make `RELAY_PROJECTS` optional; accept a `projects` argument instead of reading env directly), `apps/daemon/src/cli.ts`, `apps/daemon/src/index.ts:28`
- Test: `apps/daemon/src/cli.test.ts`, `apps/daemon/src/config.test.ts`

**Steps (TDD, one sub-change at a time):**
1. `config.ts`: `loadDaemonConfig` gains a `projects: ProjectRegistration[]` param and stops parsing `RELAY_PROJECTS` itself (delete lines 36-37; use the param at line 47). Update `config.test.ts` accordingly. Registering **zero projects is now valid** (daemon connects, user adds projects later).
2. `index.ts:28`: `const projects = await listProjects({ daemonHome, env: Bun.env }); const config = loadDaemonConfig({ env: Bun.env, hostname, projects, ... })`.
3. `cli.ts`: new commands, each resolving `daemonHome` the same way `connect.ts` does:
   - `relay project add [path] [--name <name>]` — path defaults to `process.cwd()`, name defaults to `basename(path)`; validate the directory exists before adding.
   - `relay project remove <path>`
   - `relay project list` — print name + path per line.
   Test `parseCli` for all three (including defaults) plus a `runCli` test with injected dependencies.
4. Commit: `git commit -am "feat(daemon): relay project add/remove/list CLI"`

### Task 8: Periodic project re-sync + archival instead of hard delete

**Files:**
- Modify: `convex/schema.ts:25-28` (projects table), `convex/machines.ts:48-68` (registerMachine), `convex/machine_summaries.ts` (`toProjectSummary` — include `archivedAt`), `apps/daemon/src/relay-client.ts` (`MachineReporter` — read it first; add `syncProjects`), `apps/daemon/src/index.ts` (sync on heartbeat interval)
- Test: `convex/machines.convex.test.ts` (create if absent — mirror `pairing.convex.test.ts` setup), `apps/daemon/src/relay-client` tests if present

**Steps:**
1. Schema: add `archivedAt: v.optional(v.number())` to `projects`.
2. Convex test (failing): register machine with projects A+B, re-register with only A → B row still exists with `archivedAt` set, its threads still resolvable; re-register with A+B again → B's `archivedAt` cleared.
3. Implement in `registerMachine`: replace the delete loop (`machines.ts:54-58`) with `await ctx.db.patch(project._id, { archivedAt: now })`, and in the upsert loop clear it: `await ctx.db.patch(existingProject._id, { archivedAt: undefined, name: project.name })`.
4. `claimQueuedMessage` (`conversations.ts:184`): skip threads whose project is archived (`if (!project || project.machineId !== machine._id || project.archivedAt) continue;`). `listMachinesAndProjects` keeps returning archived projects (web greys them out) — `toProjectSummary` must pass `archivedAt` through.
5. Daemon: in `index.ts`, inside the heartbeat `setInterval` (line 42), re-read `listProjects` and, when the JSON differs from the last synced value, call a new `reporter.syncProjects(projects)` which re-invokes the `registerMachine` mutation with updated projects. (Read `relay-client.ts` `MachineReporter` first; `connect()` already calls registerMachine — reuse that code path.)
6. Run `bun run test` at root → PASS. Commit: `git commit -am "feat: hot project re-sync with archival instead of deletion"`

### Task 9: Web "Add project" request flow (Convex side)

**Files:**
- Modify: `convex/schema.ts` (projects: add `status: v.optional(v.union(v.literal("pending"), v.literal("active"), v.literal("error")))` and `error: v.optional(v.string())`), create `convex/projects.ts`
- Test: `convex/projects.convex.test.ts`

**Step 1: Failing tests:**
- `requestAdd`: authenticated owner + owned machineId + path → inserts project with `status: "pending"`; non-owner rejected.
- `listPending({ deviceToken })`: returns pending projects for that machine only.
- `resolvePending({ deviceToken, projectId, ok: true })` → status "active"; `{ ok: false, error: "not found" }` → status "error" + error text.
- `claimQueuedMessage` must skip threads on non-active projects (status "pending"/"error"). Absent status = active (back-compat for existing rows).

**Step 3: Implement** `convex/projects.ts` with those three functions (`requireUser` + machine ownership for `requestAdd`; `requireActiveMachine`-style device-token auth for the other two — copy the pattern from `conversations.ts`). Also ensure `registerMachine`'s upsert marks daemon-registered projects `status: "active"`.

**Step 5: Commit** — `git commit -am "feat(convex): project add requests with daemon-side validation states"`

### Task 10: Daemon validates pending projects

**Files:**
- Create: `apps/daemon/src/project-request-worker.ts`
- Modify: `apps/daemon/src/relay-client.ts` (gateway for `projects:listPending`/`projects:resolvePending`), `apps/daemon/src/index.ts` (poll every 5s like other workers)
- Test: `apps/daemon/src/project-request-worker.test.ts`

**Steps (TDD):** worker claims pending requests via gateway; for each: path must exist and be a directory (`stat` from `node:fs/promises`) → on success, `addProject` to the local store (ignore duplicate error) and `resolvePending({ ok: true })`; on failure `resolvePending({ ok: false, error })`. Fake gateway in tests with a tmp dir (valid) and a nonexistent path (invalid). Wire into `index.ts` following the existing `setInterval` worker pattern (lines 156-191). Commit: `git commit -am "feat(daemon): validate and activate web-requested projects"`

### Task 11: Web "Add project" UI

**Files:**
- Modify: `apps/web/src/workspace-sidebar.tsx` (add per-machine "+ Add project" affordance), `apps/web/src/app.tsx` (wire mutation `projects:requestAdd`), `apps/web/src/run-data.ts` (function reference)
- Test: `apps/web/src/workspace-sidebar.test.tsx`

**Steps (TDD):**
1. Sidebar test: renders an "Add project" button per machine group; submitting the inline form (path + optional name, name defaults to last path segment) calls `onAddProject({ machineId, name, path })`; pending projects render a `pending` badge; error projects render the error text; archived projects render greyed with an "archived" badge.
2. Implement: sidebar needs machine grouping — currently `flattenProjects` (`app.tsx:46`) flattens machines; extend `SidebarProject` with `status`/`error`/`archivedAt` and group header per machine (it already shows `machineName` per project row — keep the flat list, put "+ Add project" in a machine footer row keyed by `machineId`). Keep styling in the brass/patina system.
3. `bun run build` in `apps/web` must stay under the bundle budget (`bun run bundle:check` at root).
4. Commit: `git commit -am "feat(web): add project from sidebar with pending/error states"`

**Phase 2 acceptance:** with the daemon running, `relay project add ~/code/other-repo` makes the project appear in the web sidebar within one heartbeat (≤10s) without restart; adding a path from the web UI activates it if valid on disk; removing a project archives it and old threads still open.

---

## Phase 3: Real agentic loop

Replace the single-shot tool phase + separate reply with one streaming loop: system prompt + messages array with native tool_use/tool_result blocks, iterating until the model stops requesting tools. This is the highest-value engineering in the plan. Do it provider-by-provider behind a new interface; delete the legacy path when all three API kinds are ported.

**Design (target shape, new file `apps/daemon/src/turn-loop.ts`):**

```ts
export type AssistantBlock = { kind: "text"; text: string } | { call: ToolCall; id: string; kind: "tool_use" };
export type ChatMessage =
  | { content: string; role: "user" }
  | { blocks: AssistantBlock[]; role: "assistant" }
  | { results: Array<{ content: string; isError?: boolean; toolUseId: string }>; role: "tool_results" };

export type TurnStreamEvent =
  | { kind: "text"; text: string }
  | { call: ToolCall; id: string; kind: "tool_use" }
  | { kind: "usage"; usage: TokenUsage }
  | { kind: "stop"; reason: "end_turn" | "max_tokens" | "tool_use" };

export interface TurnModelProvider {
  readonly modelId?: string;
  streamTurn(input: { messages: ChatMessage[]; signal: AbortSignal; system: string; tools: McpModelTool[] }): AsyncIterable<TurnStreamEvent>;
}
```

`runAgenticTurn` (also in `turn-loop.ts`) owns the iteration: call `streamTurn`; forward text deltas to `onText`; collect tool_use blocks; on `stop: "tool_use"` execute each call through `executeGovernedToolCall` (refusals become `isError: true` tool_results — the model sees and can react to refusals, unlike today), append the assistant message + tool_results message, check stop/steering (steering messages are appended as `user` messages before the next iteration — no longer aborting the tool phase), and continue up to `maxIterations` (default 50). Accumulate usage across iterations.

### Task 12: `runAgenticTurn` with a fake provider

**Files:** Create `apps/daemon/src/turn-loop.ts` + `apps/daemon/src/turn-loop.test.ts`.

TDD with a `FakeTurnProvider` (scripted per-iteration events). Required tests:
1. read→edit sequence: iteration 1 emits `tool_use read`, iteration 2 (after receiving tool_results containing file content) emits `tool_use edit`, iteration 3 emits text + `stop end_turn`. Assert the provider received tool_results with the read output, and messages grow correctly.
2. Refused call (deny policy) → tool_result has `isError: true` and loop continues.
3. `maxIterations` exceeded → loop stops, returns what it has, flags `exhausted: true`.
4. Steering message claimed between iterations lands as a `user` message in the next request.
5. Abort signal mid-stream → clean stop, no further iterations.
6. Usage from every iteration is summed.

Commit: `git commit -m "feat(daemon): provider-agnostic agentic turn loop"`

### Task 13: Anthropic `streamTurn`

**Files:** Create `apps/daemon/src/providers/anthropic-turn-provider.ts` + test. Reuse SSE-parsing zod schemas from `model-provider.ts`.

Two halves, both TDD with a mocked `fetcher` replaying captured SSE fixtures:
1. **Request building:** messages array maps `tool_results` role → `{ role: "user", content: [{ type: "tool_result", tool_use_id, content, is_error }] }`, assistant blocks → `tool_use`/`text` content blocks; `system` as top-level string; tools from a new descriptions module (Task 14); `max_tokens: 16384` default. Assert exact body shape.
2. **Stream parsing:** handle `content_block_start` (type `tool_use` — capture id/name), `input_json_delta` accumulation, `content_block_stop` (parse accumulated JSON → emit `tool_use` event via the existing `toolCallSchema`), `message_delta` with `stop_reason` → emit `stop` (`"tool_use"` | `"end_turn"` | `"max_tokens"`), and existing text/usage handling.

Commit per half.

### Task 14: Real tool descriptions

**Files:** Create `apps/daemon/src/tool-descriptions.ts` + test; modify `model-router.ts` `TOOL_PARAMETERS` usage.

Replace `"Relay ${name} tool"` with real prose for each tool (what it does, when to use it, constraints — e.g. read before edit, prefer specific commands over broad ones, bash cwd is the project root). ~4-8 sentences each, modeled on Claude Code's tool docs. Test asserts every tool in `TOOL_PARAMETERS` has a description ≥200 chars. Commit.

### Task 15: OpenAI Responses `streamTurn`

Same structure as Task 13 in `apps/daemon/src/providers/openai-responses-turn-provider.ts`: `input` array with `function_call` / `function_call_output` items, streamed `response.output_item.added/done` for function calls, `response.completed` for stop+usage. Commit.

### Task 16: OpenAI Completions (DeepSeek) `streamTurn`

`apps/daemon/src/providers/openai-completions-turn-provider.ts`: `messages` with `tool_calls` / role `"tool"` results, streamed `delta.tool_calls` index-based accumulation, `finish_reason` → stop. Commit.

### Task 17: Cut `agent-loop.ts` over to `runAgenticTurn`

**Files:** Modify `apps/daemon/src/agent-loop.ts`, `apps/daemon/src/catalog-provider-router.ts` (resolve to the new providers by `apiKind`), tests.

`runClaimedTurn` becomes: build system prompt (placeholder string until Phase 4), `messages = [{ role: "user", content: prompt }]`, then `runAgenticTurn` with callbacks wired to the existing gateway (onText → throttled `appendAssistantText` — switch to sending only when content grew, keep 200ms cadence; governed execution → existing `executeGovernedToolCall` with `turnPolicy`; steering → existing `claimSteeringMessages`; stop → existing `monitorStop` driving the shared AbortSignal). Keep intact: checkpoints, `snapshotDiff`, plan-phase refusal, usage recording (now summed), `completePlanning`/`completeAssistantMessage`. Update existing agent-loop tests to script the fake turn provider instead of `toolCalls` + `streamReply`. Commit.

### Task 18: Subagents on the same loop

Modify `apps/daemon/src/subagent-worker.ts`: replace its single-shot block with `runAgenticTurn` (`maxIterations = run.maxTurns`); capability checks stay per-call before governed execution. Update tests. Commit.

### Task 19: Delete the legacy path

Remove `ModelProvider.toolCalls`, `buildProviderToolRequest`, `parseProviderToolCalls`, the two-phase code in `agent-loop.ts`, and the `web_search`/`web_fetch` "delegation marker" pass-throughs (in the new loop, providers with native web search get the provider-native tool config; others simply don't get those tools — implement Anthropic native `web_search` server tool config here). `bun run test && bun run typecheck` green at root. Commit.

**Phase 3 acceptance (manual, use the `/verify` project skill):** ask Relay to "read package.json and add a `lint` script" — it must read first, then produce an edit consistent with the file's actual content, in one turn, streaming throughout.

---

## Phase 4: Conversation history + system prompt + context budget

### Task 20: History in the claim

`claimQueuedMessage` returns `history`: the last 40 non-queued messages for the thread (`role`, `content`, capped at 4000 chars each, oldest first), plus recent activity summaries from `events`. Convex test first. Daemon: `runClaimedTurn` seeds `messages` with history mapped to user/assistant `ChatMessage`s before the new user prompt. Commit.

### Task 21: System prompt builder

Create `apps/daemon/src/system-prompt.ts` + test: identity ("You are Relay, an agent running on the user's machine…"), behavioral rules (read before editing, verify with commands, concise final replies), environment block (project root, platform, current git branch + status — run `git rev-parse --abbrev-ref HEAD` / `git status --porcelain | head -20` at turn start, tolerate non-git dirs), and project instructions: read `AGENTS.md`, `CLAUDE.md`, `.relay/instructions.md` from the project root when present (cap 8000 chars each). Wire into `runClaimedTurn`. Commit.

### Task 22: Context budget enforcement

Port `packages/harness-runtime/src/context-manager.ts` concepts into the live path: estimate tokens (~4 chars/token) for system + messages; when > 80% of the model's context window (add `contextWindow` to entries in `packages/shared/src/model-catalog.ts`), drop oldest history pairs first, then truncate oldest tool_results to a stub (`[truncated: <tool> output, N chars]`). Real LLM summarization is a follow-up — record it in the plan's out-of-scope list. TDD in `turn-loop.test.ts`. Commit.

---

## Phase 5: Tool surface upgrades

Each task: extend `ToolCall` union (`tool-executor.ts:5`), `TOOL_PARAMETERS` (`model-router.ts:9`), descriptions (Task 14 module), classification (`policy.ts:22`), executor, and tests at each layer.

### Task 23: `str_replace` edit

New call shape: `{ kind: "edit", path, oldString, newString, replaceAll? }`. Semantics: `oldString` must appear exactly once (unless `replaceAll`); empty `oldString` + nonexistent file = create. Keep whole-file writes as a separate `{ kind: "write", path, content }` tool. Failure messages must be actionable ("oldString not found" / "appears 3 times"). Update `parseProviderToolCalls`-successor schemas. Commit.

### Task 24: `grep` and `glob`

`{ kind: "grep", pattern, path?, glob? }` → spawn `rg --no-heading -n -m 200` when available, fall back to `grep -rn` (detect once, cache); cap output at 20KB with a `[truncated]` marker. `{ kind: "glob", pattern }` → `Bun.Glob` scan under root, cap 500 paths, sorted by mtime. Both classify as `read`/low (path-sensitivity check still applies to grep path arg). Commit.

### Task 25: Bounded `read`

Add `offset?`/`limit?` params; default limit 2000 lines; hard cap 50KB per read with `[truncated — use offset to continue]`; prefix lines with `N→` line numbers (models edit better with line anchors). Commit.

### Task 26: `bash` timeout + output caps

`runCommand` (`tools.ts:27`): default timeout 120s (tool param `timeout` up to 600s) — kill the process group on expiry and report `[timed out after Ns]`; cap combined output at 30KB keeping head 10KB + tail 20KB. Use `Bun.spawn`'s `timeout`/`killSignal` options if sufficient, else manual `setTimeout` + `proc.kill()`. Commit.

---

## Phase 6: Prompt caching + provider resilience

### Task 27: Anthropic prompt caching

In the anthropic turn provider: `cache_control: { type: "ephemeral" }` on (a) the last system block, (b) the last content block of the second-to-last message in each request (moving cache breakpoint). Assert in request-shape tests; verify `cacheReadTokens` grows across iterations in an integration test with fixture SSE. Commit.

### Task 28: Retries + real error surfaces

Shared `fetchWithRetry` in `apps/daemon/src/providers/`: on 429/5xx/overloaded, exponential backoff (1s/2s/4s, 3 attempts, honor `retry-after`); on final failure include response body text in the error (today only status is kept — `model-provider.ts:47`). Non-retryable 4xx fail fast. TDD with a scripted fetcher. Commit.

### Task 29: Per-model `max_tokens` + thinking budget interaction

Add `maxOutputTokens` to the model catalog (`packages/shared/src/model-catalog.ts`); remove the hardcoded 4096 (`model-router.ts:49`); keep the `budget + 1024` floor rule for thinking. Commit.

---

## Explicitly deferred (do not build in this plan)

- **LLM-generated compaction summaries** (Phase 4 does budget-truncation only).
- **Sandbox enforcement** (`packages/workspace-runtime/src/sandbox/` exists but unwired) — wire after the loop rewrite settles; yolo mode makes this *more* important, note it in the README.
- **Durable per-project command allowlists** ("always allow `npm test`").
- **Kernel-vs-legacy cutover decision** — this plan improves the legacy path since it's what runs; the kernel's `LocalHarnessRuntime` still emits fake replies and must not be extended until a deliberate decision.
- **ACP / Claude-Agent-SDK supervisor providers** (the Codex adapter pattern generalized) — strategic option, separate plan.

## Verification at the end of each phase

Run at repo root: `bun run typecheck && bun run test && bun run bundle:check`. For UI-affecting phases use the project's `/verify` skill (build/launch/drive in browser). Manual yolo check: `relay start --yolo`, send a turn containing `sudo whoami` — must execute with no approval card, and the audit log must still show the allow decision.
