export type Approval = { _id: string; capability: "read" | "edit" | "exec" | "task"; decision: "pending" | "allow" | "deny"; risk: "low" | "high" | "critical"; summary: string };
export type AuditEntry = { _id: string; capability: "read" | "edit" | "exec" | "task"; decision: "allow" | "deny" | "ask"; risk: "low" | "high" | "critical"; summary: string };

export function GovernancePanel({ approvals, audit, onResolve }: {
  approvals: Approval[];
  audit: AuditEntry[];
  onResolve(input: { approvalId: string; decision: "allow" | "deny" }): Promise<unknown>;
}) {
  const pending = approvals.filter((approval) => approval.decision === "pending");
  if (pending.length === 0 && audit.length === 0) return null;
  return <section className="governance-panel">
    {pending.map((approval) => <article className="approval-card" key={approval._id}>
      <div><h2>Approval required</h2><p>{approval.capability} / {approval.risk} risk</p></div>
      <code>{approval.summary}</code>
      <div className="approval-actions"><button onClick={() => void onResolve({ approvalId: approval._id, decision: "deny" })} type="button">Deny</button><button className="approval-allow" onClick={() => void onResolve({ approvalId: approval._id, decision: "allow" })} type="button">Allow</button></div>
    </article>)}
    {audit.length > 0 ? <div className="audit-log"><h2>Governance</h2><ol>{audit.map((entry) => <li key={entry._id}><strong>{entry.decision}</strong><span>{entry.capability} / {entry.risk}</span><code>{entry.summary}</code></li>)}</ol></div> : null}
  </section>;
}
