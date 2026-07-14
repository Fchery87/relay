import { machinePresence } from "@relay/shared";

export type MachineSummary = {
  id: string;
  lastHeartbeatAt: number;
  name: string;
  platform: "darwin" | "linux" | "win32";
  projects: ReadonlyArray<{ id: string; name: string; path: string }>;
};

const OFFLINE_AFTER_MS = 30_000;

export function MachineSidebar({
  machines,
  now,
  onRevoke,
}: {
  machines: ReadonlyArray<MachineSummary>;
  now: number;
  onRevoke?: (machineId: string) => Promise<void>;
}) {
  return (
    <aside className="sidebar" aria-label="Machines and projects">
      <div className="wordmark">Relay</div>
      <nav className="machine-list">
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
                <span className="machine-status">{presence === "online" ? "Online" : "Offline"}</span>
                {onRevoke ? <button aria-label={`Disconnect ${machine.name}`} onClick={() => void onRevoke(machine.id)} type="button">Disconnect</button> : null}
              </div>
              <ul className="project-list">
                {machine.projects.map((project) => (
                  <li key={project.id}>
                    <a className="project-link" href={`#${project.id}`} title={project.path}>
                      {project.name}
                    </a>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </nav>
    </aside>
  );
}
