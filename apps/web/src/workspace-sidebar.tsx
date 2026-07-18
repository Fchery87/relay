import { useState } from "react";
import type { ReactNode } from "react";

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
  id: string;
  machineName: string;
  name: string;
  path: string;
  presence: "online" | "offline";
};

const KIND_LABELS: Readonly<Record<NeedsYouKind, string>> = {
  approval: "approval",
  elicitation: "question",
  failed: "failed",
  "plan-review": "plan review",
};

export function WorkspaceSidebar({
  activeProjectId,
  attention,
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
  onNewPlan?: (projectId: string) => void;
  onNewTask?: (projectId: string) => void;
  onOpenPalette?: () => void;
  onOpenSettings?: () => void;
  onSelectAttention?: (item: NeedsYouItem) => void;
  projects: ReadonlyArray<SidebarProject>;
  renderRuns: (projectId: string) => ReactNode;
}) {
  // Tracks projects the user has toggled away from their default state
  // (active project defaults to expanded, others to collapsed).
  const [toggled, setToggled] = useState<ReadonlySet<string>>(new Set());

  function toggleProject(projectId: string) {
    setToggled((current) => {
      const next = new Set(current);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });
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
        {projects.map((project) => {
          const expandedByDefault = project.id === activeProjectId;
          const expanded = toggled.has(project.id) ? !expandedByDefault : expandedByDefault;
          return (
            <section aria-current={project.id === activeProjectId ? "true" : undefined} className="project-group" key={project.id}>
              <button aria-expanded={expanded} className="project-row" onClick={() => toggleProject(project.id)} title={project.path} type="button">
                <span aria-hidden="true" className="project-chevron">{expanded ? "▾" : "▸"}</span>
                <span className="project-name">{project.name}</span>
                <span className={`presence presence-${project.presence}`} aria-hidden="true" />
                <small className="project-machine">{project.machineName}</small>
              </button>
              {expanded ? (
                <div className="project-runs">
                  {renderRuns(project.id)}
                  <div className="project-actions">
                    {onNewTask ? <button className="project-new-task" onClick={() => onNewTask(project.id)} type="button">+ New task</button> : <span className="project-new-task">+ New task</span>}
                    {onNewPlan ? <button className="project-new-plan" onClick={() => onNewPlan(project.id)} type="button">New plan</button> : null}
                  </div>
                </div>
              ) : null}
            </section>
          );
        })}
      </nav>

      <footer className="sidebar-footer">
        <button className="sidebar-settings" onClick={() => onOpenSettings?.()} type="button">
          <span aria-hidden="true">⚙</span> Settings
        </button>
      </footer>
    </aside>
  );
}
