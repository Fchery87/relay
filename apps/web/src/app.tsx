import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "@tanstack/react-router";
import { Authenticated, AuthLoading, Unauthenticated, useMutation, useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { useAuthActions } from "@convex-dev/auth/react";

import { AuthPanel } from "./auth-panel";
import { CommandPalette, type PaletteItem } from "./command-palette";
import { McpServerPanel, type McpServer } from "./mcp-server-panel";
import type { McpServerConfig } from "@relay/shared";
import { PairingPanel } from "./pairing-panel";
import { RelayBrand } from "./relay-brand";
import { resolveSettingsSection, SettingsView, type SettingsSection } from "./settings-view";
import { shortcutForEvent, useShellState } from "./shell-state";
import { SubagentPanel, type RoleRecord } from "./subagent-panel";
import { ThreadView } from "./thread-view";
import { canonicalCommandEnvelope, canonicalRunCreationRequest, canonicalRunData, createCanonicalRunRef, createThreadRef, listNeedsYou, projectionCutoverEnabled, removeThreadRef, requestAddProjectRef, submitCanonicalCommand, toRunSummaries, type LegacyRunSummary, type MachineSummary, type ProjectionRunSummary } from "./run-data";
import { WorkspaceSidebar, type SidebarProject } from "./workspace-sidebar";
import type { ThinkingLevel } from "@relay/shared";

const listMachinesAndProjects = makeFunctionReference<"query", Record<string, never>, MachineSummary[]>(
  "machines:listMachinesAndProjects",
);
const revokeMachine = makeFunctionReference<"mutation", { machineId: string }, null>("machines:revoke");
const getMe = makeFunctionReference<"query", Record<string, never>, { email: string | null }>("users:me");
const listRoles = makeFunctionReference<"query", Record<string, never>, RoleRecord[]>("subagents:listRoles");
const updateRole = makeFunctionReference<"mutation", { capabilities?: Array<"read" | "edit" | "exec" | "task">; contextMode?: "fresh" | "forked"; description?: string; maxTurns?: number; modelId?: string; prompt?: string; roleId: string; thinkingLevel?: ThinkingLevel; writer?: boolean }, null>("subagents:updateRole");
const listMcpServers = makeFunctionReference<"query", { projectId: string }, McpServer[]>("mcp_servers:listForProject");
const createMcpServer = makeFunctionReference<"mutation", { name: string; projectId: string; threadId: string; transport: McpServerConfig["transport"] }, string>("mcp_servers:create");
const updateMcpServer = makeFunctionReference<"mutation", McpServerConfig & { serverId: string }, null>("mcp_servers:update");
const removeMcpServer = makeFunctionReference<"mutation", { serverId: string }, null>("mcp_servers:remove");

const OFFLINE_AFTER_MS = 30_000;

function useCurrentTime(): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const intervalId = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(intervalId);
  }, []);

  return now;
}

function flattenProjects(machines: ReadonlyArray<MachineSummary>, now: number) {
  return machines.flatMap((machine) => machine.projects.map((project) => ({
    ...project,
    capabilityCeiling: machine.capabilityCeiling,
    machineId: machine.id,
    machineName: machine.name,
    presence: (now - machine.lastHeartbeatAt <= OFFLINE_AFTER_MS ? "online" : "offline") as "online" | "offline",
  })));
}

export function ConnectedWorkspace() {
  return <><AuthLoading><main className="auth-workspace"><div className="loading-state"><RelayBrand /><p>Connecting to your workbench</p></div></main></AuthLoading><Unauthenticated><AuthPanel /></Unauthenticated><Authenticated><AuthenticatedWorkspace /></Authenticated></>;
}

export function ConnectedSettings() {
  return <><AuthLoading><main className="auth-workspace"><div className="loading-state"><RelayBrand /><p>Connecting to your workbench</p></div></main></AuthLoading><Unauthenticated><AuthPanel /></Unauthenticated><Authenticated><AuthenticatedSettings /></Authenticated></>;
}

function AuthenticatedWorkspace() {
  const machines = useQuery(listMachinesAndProjects, {});
  return <Workspace machines={machines} state={machines === undefined ? "loading" : "ready"} />;
}

export function UnconfiguredWorkspace() {
  return <main className="auth-workspace"><div className="loading-state"><RelayBrand /><p>Set VITE_CONVEX_URL to connect this browser.</p></div></main>;
}

function SidebarRuns({ activeThreadId, onSelectRun, projectId }: { activeThreadId?: string; onSelectRun: (projectId: string, threadId: string) => void; projectId: string }) {
  const runs = toRunSummaries(useQuery(canonicalRunData.listRuns, { projectId }) as Array<LegacyRunSummary | ProjectionRunSummary> | undefined);
  const removeThread = useMutation(removeThreadRef);
  const navigate = useNavigate();
  const [pendingDelete, setPendingDelete] = useState<{ threadId: string; title: string } | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (pendingDelete && !dialog.open) dialog.showModal();
    if (!pendingDelete && dialog.open) dialog.close();
  }, [pendingDelete]);

  if (runs === undefined) return <p className="sidebar-empty">Loading runs…</p>;
  if (runs.length === 0) return <p className="sidebar-empty">No runs yet</p>;
  return (
    <>
      <ul className="run-list">
        {runs.map((run) => (
          <li key={run.runId}>
            <button aria-current={run.runId === activeThreadId ? "page" : undefined} className="run-link" onClick={() => onSelectRun(projectId, run.runId)} type="button">
              <span aria-hidden="true" className="run-status-dot" data-thread-status={run.status} />
              <span className="run-title">{run.title}</span>
              <button
                aria-label="Delete task"
                className="run-delete"
                onClick={(e) => { e.stopPropagation(); setPendingDelete({ threadId: run.runId, title: run.title }); }}
                type="button"
              >
                ✕
              </button>
            </button>
          </li>
        ))}
      </ul>
      <dialog
        className="run-delete-confirm-dialog"
        onCancel={(e) => { e.preventDefault(); setPendingDelete(null); }}
        ref={dialogRef}
      >
        <form
          method="dialog"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!pendingDelete) return;
            await removeThread({ threadId: pendingDelete.threadId });
            if (activeThreadId === pendingDelete.threadId) navigate({ to: `/projects/${projectId}` });
            setPendingDelete(null);
          }}
        >
          <span className="dialog-kicker">Destructive action</span>
          <h2>Delete task</h2>
          <p>This will permanently remove all messages, plans, and activity for <strong>{pendingDelete?.title ?? "this thread"}</strong>.</p>
          <footer>
            <button onClick={() => setPendingDelete(null)} type="button">Cancel</button>
            <button className="button-primary button-destructive" type="submit">Delete</button>
          </footer>
        </form>
      </dialog>
    </>
  );
}

function Workspace({
  machines,
  state,
}: {
  machines: MachineSummary[] | undefined;
  state: "loading" | "ready" | "unconfigured";
}) {
  const now = useCurrentTime();
  const navigate = useNavigate();
  const params = useParams({ strict: false }) as { projectId?: string; threadId?: string };
  const { paletteOpen, panels, setPaletteOpen, toggle } = useShellState();
  const attention = useQuery(listNeedsYou, {});
  const create = useMutation(createThreadRef);
  const createCanonical = useMutation(createCanonicalRunRef);
  const submitCanonical = useMutation(submitCanonicalCommand);
  const requestAddProject = useMutation(requestAddProjectRef);
  const machineCount = machines?.length ?? 0;
  const projects = useMemo(() => flattenProjects(machines ?? [], now), [machines, now]);
  const requestedProject = params.projectId ? projects.find((project) => project.id === params.projectId) : undefined;
  const activeProject = requestedProject ?? (params.projectId ? undefined : projects[0]);
  const activeProjectRuns = toRunSummaries(useQuery(canonicalRunData.listRuns, activeProject ? { projectId: activeProject.id } : "skip") as Array<LegacyRunSummary | ProjectionRunSummary> | undefined);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const shortcut = shortcutForEvent(event);
      if (!shortcut) return;
      event.preventDefault();
      if (shortcut === "palette") setPaletteOpen(!paletteOpen);
      else toggle(shortcut);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [paletteOpen, setPaletteOpen, toggle]);

  function openRun(projectId: string, threadId: string) {
    void navigate({ to: "/projects/$projectId/threads/$threadId", params: { projectId, threadId }, search: {} });
  }

  async function startThread(projectId: string, mode: "chat" | "plan") {
    const title = mode === "plan" ? "Untitled plan" : "Untitled task";
    const threadId = projectionCutoverEnabled
      ? await createCanonical(canonicalRunCreationRequest({ mode, projectId, title }))
      : await create({ mode, projectId, title });
    if (projectionCutoverEnabled) {
      await submitCanonical(canonicalCommandEnvelope({ kind: "run.resume", payload: {}, runId: threadId, threadId }));
    }
    void navigate({ to: "/projects/$projectId/threads/$threadId", params: { projectId, threadId }, search: { view: mode === "plan" ? "plan" : "session" } });
  }

  const paletteItems = useMemo<PaletteItem[]>(() => {
    const runItems: PaletteItem[] = (activeProjectRuns ?? []).map((run) => ({
      detail: activeProject?.name,
      id: `run:${activeProject?.id}:${run.runId}`,
      kind: "run",
      label: run.title,
    }));
    const projectItems: PaletteItem[] = projects.map((project) => ({
      detail: project.machineName,
      id: `project:${project.id}`,
      kind: "action",
      label: `Open project ${project.name}`,
    }));
    const actionItems: PaletteItem[] = [
      ...(activeProject ? [
        { id: `new-task:${activeProject.id}`, kind: "action" as const, label: `New task in ${activeProject.name}` },
        { id: `new-plan:${activeProject.id}`, kind: "action" as const, label: `New plan in ${activeProject.name}` },
      ] : []),
      { id: "toggle:sidebar", kind: "action", label: "Toggle sidebar", shortcut: "⌘B" },
      { id: "toggle:terminal", kind: "action", label: "Toggle terminal drawer", shortcut: "⌘J" },
      { id: "toggle:inspector", kind: "action", label: "Toggle inspector", shortcut: "⌘I" },
      { id: "settings:account", kind: "action", label: "Settings → Account" },
      { id: "settings:machines", kind: "action", label: "Settings → Machines" },
      { id: "settings:connections", kind: "action", label: "Settings → Connections" },
    ];
    return [...runItems, ...projectItems, ...actionItems];
  }, [activeProject, activeProjectRuns, projects]);

  function onPaletteSelect(item: PaletteItem) {
    const [kind, ...rest] = item.id.split(":");
    const argument = rest.join(":");
    if (kind === "run" && activeProject) {
      const [projectId, threadId] = [rest[0], rest.slice(1).join(":")];
      if (projectId && threadId) openRun(projectId, threadId);
    } else if (kind === "project") {
      void navigate({ to: "/projects/$projectId", params: { projectId: argument }, search: {} });
    } else if (kind === "new-task") {
      void startThread(argument, "chat");
    } else if (kind === "new-plan") {
      void startThread(argument, "plan");
    } else if (kind === "toggle") {
      if (argument === "sidebar" || argument === "terminal" || argument === "inspector") toggle(argument);
    } else if (kind === "settings") {
      void navigate({ to: "/settings/$section", params: { section: argument } });
    }
  }

  const sidebarProjects: SidebarProject[] = projects.map((project) => ({
    archivedAt: project.archivedAt,
    error: project.error,
    id: project.id,
    machineId: project.machineId,
    machineName: project.machineName,
    name: project.name,
    path: project.path,
    presence: project.presence,
    status: project.status,
  }));

  return (
    <div className="app-shell" data-sidebar-open={panels.sidebar}>
      {panels.sidebar ? (
        <WorkspaceSidebar
          activeProjectId={activeProject?.id}
          attention={attention ?? []}
          onAddProject={(params) => void requestAddProject({ machineId: params.machineId, name: params.name, path: params.path })}
          onNewPlan={(projectId) => void startThread(projectId, "plan")}
          onNewTask={(projectId) => void startThread(projectId, "chat")}
          onOpenPalette={() => setPaletteOpen(true)}
          onOpenSettings={() => void navigate({ to: "/settings" })}
          onSelectAttention={(item) => openRun(item.projectId, item.threadId)}
          projects={sidebarProjects}
          renderRuns={(projectId) => <SidebarRuns activeThreadId={params.threadId} onSelectRun={openRun} projectId={projectId} />}
        />
      ) : null}
      <main className="workspace">
        {state === "unconfigured" ? (
          <p className="workspace-state">Set VITE_CONVEX_URL to connect this browser.</p>
        ) : state === "loading" ? (
          <p className="workspace-state">Connecting to Relay...</p>
        ) : machineCount === 0 ? (
          <PairingPanel />
        ) : params.projectId && !requestedProject ? (
          <section className="workspace-state" role="status"><h2>Project not available</h2><p>This project is unavailable or is not connected to your account.</p><button onClick={() => void navigate({ to: "/", search: {} })} type="button">Return to workspace</button></section>
        ) : !activeProject ? (
          <p className="workspace-state">No projects discovered on the connected machines.</p>
        ) : (
          <ThreadView
            capabilityCeiling={activeProject.capabilityCeiling}
            inspectorOpen={panels.inspector}
            key={activeProject.id}
            machineName={activeProject.machineName}
            onToggleInspector={() => toggle("inspector")}
            onToggleSidebar={() => toggle("sidebar")}
            onToggleTerminal={() => toggle("terminal")}
            projectId={activeProject.id}
            projectName={activeProject.name}
            requestedThreadId={params.threadId}
            terminalOpen={panels.terminal}
          />
        )}
      </main>
      <CommandPalette items={paletteItems} onClose={() => setPaletteOpen(false)} onSelect={onPaletteSelect} open={paletteOpen} />
    </div>
  );
}

function AuthenticatedSettings() {
  const navigate = useNavigate();
  const params = useParams({ strict: false }) as { section?: string };
  const section: SettingsSection = resolveSettingsSection(params.section);
  const now = useCurrentTime();
  const machines = useQuery(listMachinesAndProjects, {});
  const me = useQuery(getMe, {});
  const roles = useQuery(listRoles, {});
  const revoke = useMutation(revokeMachine);
  const saveRole = useMutation(updateRole);
  const { signOut } = useAuthActions();
  const projects = useMemo(() => flattenProjects(machines ?? [], now), [machines, now]);
  const [pickedProjectId, setPickedProjectId] = useState<string>();
  const selectedProject = projects.find((project) => project.id === pickedProjectId) ?? projects[0];

  return (
    <main className="settings-page">
      <SettingsView
        agentsContent={<SubagentPanel onUpdateRole={(input) => saveRole(input)} roles={roles ?? []} runs={[]} />}
        connectionsContent={selectedProject ? <SettingsConnections projectId={selectedProject.id} /> : <p className="settings-hint">Connect a machine with a project first.</p>}
        email={me?.email ?? undefined}
        machines={machines ?? []}
        now={now}
        onBack={() => void navigate({ to: "/" })}
        onNavigateSection={(next) => void navigate({ to: "/settings/$section", params: { section: next } })}
        onRevoke={async (machineId) => { await revoke({ machineId }); }}
        onSignOut={async () => { await signOut(); void navigate({ to: "/" }); }}
        pairingContent={<PairingPanel />}
        projectName={selectedProject?.name}
        section={section}
      />
      {(section === "connections" || section === "budgets") && projects.length > 1 ? (
        <label className="settings-project-picker">
          <span>Project</span>
          <select onChange={(event) => setPickedProjectId(event.target.value)} value={selectedProject?.id}>
            {projects.map((project) => <option key={project.id} value={project.id}>{project.name} · {project.machineName}</option>)}
          </select>
        </label>
      ) : null}
    </main>
  );
}

function SettingsConnections({ projectId }: { projectId: string }) {
  const servers = useQuery(listMcpServers, { projectId });
  const runs = toRunSummaries(useQuery(canonicalRunData.listRuns, { projectId }) as Array<LegacyRunSummary | ProjectionRunSummary> | undefined);
  const createMcp = useMutation(createMcpServer);
  const updateMcp = useMutation(updateMcpServer);
  const removeMcp = useMutation(removeMcpServer);
  const approvalThreadId = runs?.[0]?.runId;

  if (!approvalThreadId) return <p className="settings-hint">Start a task in this project first — MCP connections attach their approvals to a run.</p>;
  return (
    <McpServerPanel
      onCreate={(input) => createMcp({ ...input, projectId, threadId: approvalThreadId })}
      onRemove={(serverId) => removeMcp({ serverId })}
      onUpdate={(input) => updateMcp(input)}
      servers={servers ?? []}
    />
  );
}
