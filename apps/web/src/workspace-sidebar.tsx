import { useMemo, useState } from "react";
import type { FormEvent, ReactNode } from "react";

import { RelayBrand } from "./relay-brand";

export type NeedsYouKind = "approval" | "plan-review" | "elicitation" | "failed";

export type NeedsYouItem = {
  kind: NeedsYouKind;
  projectId: string;
  projectName: string;
  threadId: string;
  title: string;
};

export type SidebarProject = {
  archivedAt?: number;
  error?: string;
  id: string;
  machineId: string;
  machineName: string;
  name: string;
  path: string;
  presence: "online" | "offline";
  status?: string;
};

const KIND_LABELS: Readonly<Record<NeedsYouKind, string>> = {
  approval: "approval",
  elicitation: "question",
  failed: "failed",
  "plan-review": "plan review",
};

type MachineGroup = {
  machineId: string;
  machineName: string;
  presence: "online" | "offline";
  projects: SidebarProject[];
};

function groupByMachine(projects: ReadonlyArray<SidebarProject>): MachineGroup[] {
  const groups: MachineGroup[] = [];
  for (const project of projects) {
    const lastGroup = groups[groups.length - 1];
    if (lastGroup && lastGroup.machineId === project.machineId) {
      lastGroup.projects.push(project);
    } else {
      groups.push({
        machineId: project.machineId,
        machineName: project.machineName,
        presence: project.presence,
        projects: [project],
      });
    }
  }
  return groups;
}

export function WorkspaceSidebar({
  activeProjectId,
  attention,
  onAddProject,
  onNewPlan,
  onNewTask,
  onOpenPalette,
  onOpenSettings,
  onSelectAttention,
  projects,
  renderRuns,
}: {
  activeProjectId: string | undefined;
  attention: ReadonlyArray<NeedsYouItem>;
  onAddProject?: (params: { machineId: string; name: string; path: string }) => void;
  onNewPlan?: (projectId: string) => void;
  onNewTask?: (projectId: string) => void;
  onOpenPalette?: () => void;
  onOpenSettings?: () => void;
  onSelectAttention?: (item: NeedsYouItem) => void;
  projects: ReadonlyArray<SidebarProject>;
  renderRuns: (projectId: string) => ReactNode;
}) {
  const [toggled, setToggled] = useState<ReadonlySet<string>>(new Set());
  const [addingForMachine, setAddingForMachine] = useState<string | null>(null);
  const [addPath, setAddPath] = useState("");
  const [addName, setAddName] = useState("");
  const [addError, setAddError] = useState<string | null>(null);

  const machineGroups = useMemo(() => groupByMachine(projects), [projects]);

  function toggleProject(projectId: string) {
    setToggled((current) => {
      const next = new Set(current);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });
  }

  function startAdd(machineId: string) {
    setAddingForMachine(machineId);
    setAddPath("");
    setAddName("");
    setAddError(null);
  }

  function cancelAdd() {
    setAddingForMachine(null);
    setAddPath("");
    setAddName("");
    setAddError(null);
  }

  function submitAdd(event: FormEvent) {
    event.preventDefault();
    const trimmedPath = addPath.trim();
    if (!trimmedPath) {
      setAddError("Path is required");
      return;
    }
    const projectName = addName.trim() || trimmedPath.split("/").filter(Boolean).pop() || trimmedPath;
    onAddProject?.({ machineId: addingForMachine!, name: projectName, path: trimmedPath });
    cancelAdd();
  }

  function renderStatusBadge(project: SidebarProject) {
    if (project.archivedAt) {
      return <span className="project-badge project-badge-archived" aria-label="Archived project">archived</span>;
    }
    if (project.status === "pending") {
      return <span className="project-badge project-badge-pending" aria-label="Pending project">pending</span>;
    }
    if (project.status === "error" && project.error) {
      return <span className="project-badge project-badge-error" title={project.error} aria-label={`Error: ${project.error}`}>{project.error}</span>;
    }
    return null;
  }

  return (
    <aside aria-label="Relay workspace navigation" className="sidebar">
      <div className="sidebar-brand"><RelayBrand /></div>

      <button className="sidebar-search" onClick={() => onOpenPalette?.()} type="button">
        <span>Search</span>
        <kbd>⌘K</kbd>
      </button>

      {attention.length > 0 ? (
        <section aria-label="Runs that need you" className="needs-you">
          <header className="sidebar-section-heading">
            <p className="sidebar-section-title">Needs you</p>
            <span aria-hidden="true" className="needs-you-badge">◆ {attention.length}</span>
          </header>
          <ul>
            {attention.map((item) => (
              <li key={`${item.threadId}:${item.kind}`}>
                <button onClick={() => onSelectAttention?.(item)} type="button">
                  <span aria-hidden="true" className="needs-you-contact">◆</span>
                  <span className="needs-you-title">{item.title}</span>
                  <small>{item.projectName} · {KIND_LABELS[item.kind]}</small>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <div className="sidebar-section-heading"><p className="sidebar-section-title">Projects</p></div>
      <nav aria-label="Projects and runs" className="project-tree">
        {projects.length === 0 ? <p className="sidebar-empty">No machines connected</p> : null}
        {machineGroups.map((group) => (
          <div className="machine-group" key={group.machineId}>
            {group.projects.map((project) => {
              const expandedByDefault = project.id === activeProjectId;
              const expanded = toggled.has(project.id) ? !expandedByDefault : expandedByDefault;
              const isArchived = Boolean(project.archivedAt);
              return (
                <section
                  aria-current={project.id === activeProjectId ? "true" : undefined}
                  className={`project-group${isArchived ? " project-archived" : ""}`}
                  key={project.id}
                >
                  <button
                    aria-expanded={expanded}
                    className="project-row"
                    onClick={() => toggleProject(project.id)}
                    title={project.path}
                    type="button"
                  >
                    <span aria-hidden="true" className="project-chevron">{expanded ? "▾" : "▸"}</span>
                    <span className="project-name">{project.name}</span>
                    {renderStatusBadge(project)}
                    <span className={`presence presence-${project.presence}`} aria-hidden="true" />
                    <small className="project-machine">{project.machineName}</small>
                  </button>
                  {expanded ? (
                    <div className="project-runs">
                      {renderRuns(project.id)}
                      {!isArchived ? (
                        <div className="project-actions">
                          {onNewTask ? <button className="project-new-task" onClick={() => onNewTask(project.id)} type="button">+ New task</button> : <span className="project-new-task">+ New task</span>}
                          {onNewPlan ? <button className="project-new-plan" onClick={() => onNewPlan(project.id)} type="button">New plan</button> : null}
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </section>
              );
            })}
            {onAddProject ? (
              <div className="add-project-row">
                {addingForMachine === group.machineId ? (
                  <form className="add-project-form" onSubmit={submitAdd}>
                    <input
                      aria-label="Project path"
                      className="add-project-input"
                      onChange={(e) => { setAddPath(e.target.value); setAddError(null); }}
                      placeholder="path (e.g. ~/code/my-project)"
                      type="text"
                      value={addPath}
                    />
                    <input
                      aria-label="Project name (optional)"
                      className="add-project-input"
                      onChange={(e) => setAddName(e.target.value)}
                      placeholder="name (optional)"
                      type="text"
                      value={addName}
                    />
                    <div className="add-project-actions">
                      <button className="add-project-submit" type="submit">Add</button>
                      <button className="add-project-cancel" onClick={cancelAdd} type="button">Cancel</button>
                    </div>
                    {addError ? <p className="add-project-error" role="alert">{addError}</p> : null}
                  </form>
                ) : (
                  <button
                    className="add-project-trigger"
                    onClick={() => startAdd(group.machineId)}
                    type="button"
                  >
                    + Add project
                  </button>
                )}
              </div>
            ) : null}
          </div>
        ))}
      </nav>

      <footer className="sidebar-footer">
        <button className="sidebar-settings" onClick={() => onOpenSettings?.()} type="button">
          <span aria-hidden="true">⚙</span> Settings
        </button>
      </footer>
    </aside>
  );
}
