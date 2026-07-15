import { machinePresence } from "@relay/shared";
import { useState } from "react";

import { DensityControl } from "./density-control";
import { RelayBrand } from "./relay-brand";

export type MachineSummary = {
  capabilityCeiling?: ReadonlyArray<"read" | "edit" | "exec" | "task">;
  id: string;
  lastHeartbeatAt: number;
  name: string;
  platform: "darwin" | "linux" | "win32";
  projects: ReadonlyArray<{ id: string; name: string; path: string }>;
};

const OFFLINE_AFTER_MS = 30_000;
const PLATFORM_LABELS: Record<MachineSummary["platform"], string> = {
  darwin: "macOS",
  linux: "Linux",
  win32: "Windows",
};

export function MachineSidebar({
  machines,
  now,
  onRevoke,
  onSelectProject,
  selectedProjectId,
}: {
  machines: ReadonlyArray<MachineSummary>;
  now: number;
  onRevoke?: (machineId: string) => Promise<void>;
  onSelectProject?: (projectId: string) => void;
  selectedProjectId?: string;
}) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const selectedProject = machines.flatMap((machine) => machine.projects).find((project) => project.id === selectedProjectId);

  return (
    <aside className="sidebar" aria-label="Machines and projects">
      <div className="sidebar-brand"><RelayBrand /></div>
      <button aria-controls="machine-navigation" aria-expanded={mobileOpen} className="sidebar-mobile-toggle" onClick={() => setMobileOpen((open) => !open)} type="button">
        <span>{selectedProject?.name ?? "Select project"}</span>
        <span>{machines.length} {machines.length === 1 ? "machine" : "machines"}</span>
      </button>
      <p className="sidebar-section-title">Machines</p>
      <nav aria-label="Connected machines" className="machine-list" data-mobile-open={mobileOpen} id="machine-navigation">
        {machines.length === 0 ? <p className="sidebar-empty">No machines connected</p> : null}
        {machines.map((machine) => {
          const presence = machinePresence({
            heartbeatAt: machine.lastHeartbeatAt,
            now,
            offlineAfterMs: OFFLINE_AFTER_MS,
          });

          return (
            <section className="machine" key={machine.id}>
              <div className="machine-row">
                <span className={`presence presence-${presence}`} aria-hidden="true" />
                <span className="machine-name">{machine.name}</span>
                <span className="machine-status">{PLATFORM_LABELS[machine.platform]} · {presence === "online" ? "Online" : "Offline"}</span>
                {onRevoke ? <button aria-label={`Disconnect ${machine.name}`} onClick={() => void onRevoke(machine.id)} type="button">Disconnect</button> : null}
              </div>
              <ul className="project-list">
                {machine.projects.map((project) => (
                  <li key={project.id}>
                    <a aria-current={selectedProjectId === project.id ? "page" : undefined} className="project-link" href={`#${project.id}`} onClick={(event) => { event.preventDefault(); onSelectProject?.(project.id); setMobileOpen(false); }} title={project.path}>
                      {project.name}
                    </a>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </nav>
      <footer className="sidebar-footer"><DensityControl /></footer>
    </aside>
  );
}
