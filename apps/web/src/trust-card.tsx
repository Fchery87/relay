import type { FormEvent } from "react";

export type TrustCardProject = {
  projectId: string;
  projectName: string;
  projectPath: string;
};

export function TrustCard({ onResolve, project }: { onResolve(input: { projectId: string; trustState: "trusted" | "untrusted" }): Promise<unknown> | unknown; project: TrustCardProject }) {
  async function handleTrust(event: FormEvent) {
    event.preventDefault();
    await onResolve({ projectId: project.projectId, trustState: "trusted" });
  }
  async function handleDeny(event: FormEvent) {
    event.preventDefault();
    await onResolve({ projectId: project.projectId, trustState: "untrusted" });
  }
  return (
    <section className="approval-card trust-card">
      <div>
        <h2>Project trust request</h2>
        <p>{project.projectName}</p>
        <small>{project.projectPath}</small>
      </div>
      <p className="trust-explanation">
        This project defines local commands, skills, or hooks. Loading them lets the repo influence the agent.
      </p>
      <form onSubmit={handleTrust}>
        <div className="trust-actions">
          <button onClick={handleTrust} type="button">Trust</button>
          <button className="trust-deny" onClick={handleDeny} type="button">Don't trust</button>
        </div>
      </form>
    </section>
  );
}
