import { useEffect, useState } from "react";
import { useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";

import { MachineSidebar, type MachineSummary } from "./machine-sidebar";

const listMachinesAndProjects = makeFunctionReference<"query", Record<string, never>, MachineSummary[]>(
  "machines:listMachinesAndProjects",
);

function useCurrentTime(): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const intervalId = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(intervalId);
  }, []);

  return now;
}

export function ConnectedWorkspace() {
  const machines = useQuery(listMachinesAndProjects, {});
  return <Workspace machines={machines} state={machines === undefined ? "loading" : "ready"} />;
}

export function UnconfiguredWorkspace() {
  return <Workspace machines={[]} state="unconfigured" />;
}

function Workspace({
  machines,
  state,
}: {
  machines: MachineSummary[] | undefined;
  state: "loading" | "ready" | "unconfigured";
}) {
  const now = useCurrentTime();
  const machineCount = machines?.length ?? 0;

  return (
    <div className="app-shell">
      <MachineSidebar machines={machines ?? []} now={now} />
      <main className="workspace">
        <header className="workspace-header">
          <h1>Projects</h1>
        </header>
        {state === "unconfigured" ? (
          <p className="workspace-state">Set VITE_CONVEX_URL to connect this browser.</p>
        ) : state === "loading" ? (
          <p className="workspace-state">Connecting to Relay...</p>
        ) : machineCount === 0 ? (
          <p className="workspace-state">No machines connected.</p>
        ) : (
          <p className="workspace-state">Select a project to start a thread.</p>
        )}
      </main>
    </div>
  );
}
