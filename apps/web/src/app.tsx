import { useEffect, useState } from "react";
import { Authenticated, AuthLoading, Unauthenticated, useMutation, useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { useAuthActions } from "@convex-dev/auth/react";

import { AuthPanel } from "./auth-panel";
import { MachineSidebar, type MachineSummary } from "./machine-sidebar";
import { PairingPanel } from "./pairing-panel";
import { ThreadView } from "./thread-view";

const listMachinesAndProjects = makeFunctionReference<"query", Record<string, never>, MachineSummary[]>(
  "machines:listMachinesAndProjects",
);
const revokeMachine = makeFunctionReference<"mutation", { machineId: string }, null>("machines:revoke");

function useCurrentTime(): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const intervalId = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(intervalId);
  }, []);

  return now;
}

export function ConnectedWorkspace() {
  return <><AuthLoading><main className="auth-workspace"><p>Loading Relay...</p></main></AuthLoading><Unauthenticated><AuthPanel /></Unauthenticated><Authenticated><AuthenticatedWorkspace /></Authenticated></>;
}

function AuthenticatedWorkspace() {
  const machines = useQuery(listMachinesAndProjects, {});
  const revoke = useMutation(revokeMachine);
  const { signOut } = useAuthActions();
  return <Workspace machines={machines} onRevoke={(machineId) => revoke({ machineId })} onSignOut={signOut} state={machines === undefined ? "loading" : "ready"} />;
}

export function UnconfiguredWorkspace() {
  return <Workspace machines={[]} state="unconfigured" />;
}

function Workspace({
  machines,
  onRevoke,
  onSignOut,
  state,
}: {
  machines: MachineSummary[] | undefined;
  onRevoke?: (machineId: string) => Promise<unknown>;
  onSignOut?: () => Promise<void>;
  state: "loading" | "ready" | "unconfigured";
}) {
  const now = useCurrentTime();
  const machineCount = machines?.length ?? 0;
  const firstProject = machines?.[0]?.projects[0];

  return (
    <div className="app-shell">
      <MachineSidebar machines={machines ?? []} now={now} onRevoke={onRevoke} />
      <main className="workspace">
        <header className="workspace-header">
          <h1>Projects</h1>
          {onSignOut ? <button onClick={() => void onSignOut()} type="button">Sign out</button> : null}
        </header>
        {state === "unconfigured" ? (
          <p className="workspace-state">Set VITE_CONVEX_URL to connect this browser.</p>
        ) : state === "loading" ? (
          <p className="workspace-state">Connecting to Relay...</p>
        ) : machineCount === 0 ? (
          <PairingPanel />
        ) : (
          <ThreadView projectId={firstProject!.id} />
        )}
      </main>
    </div>
  );
}
