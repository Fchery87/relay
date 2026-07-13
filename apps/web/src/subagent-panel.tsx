import type { Capability, SubagentResult, ThinkingLevel } from "@relay/shared";

export type RoleRecord = { _id: string; capabilities: Capability[]; contextMode: "fresh" | "forked"; description: string; maxTurns: number; modelId: string; name: string; prompt: string; thinkingLevel: ThinkingLevel; writer: boolean };
export type SubagentRun = { _id: string; capabilities: Capability[]; depth: number; parentRunId?: string; result?: SubagentResult; roleId: string; status: "queued" | "running" | "complete" | "failed"; task: string };

export function SubagentPanel({ onUpdateRole, roles, runs }: {
  onUpdateRole(input: { capabilities?: Capability[]; contextMode?: "fresh" | "forked"; description?: string; maxTurns?: number; modelId?: string; prompt?: string; roleId: string; thinkingLevel?: ThinkingLevel; writer?: boolean }): unknown;
  roles: RoleRecord[];
  runs: SubagentRun[];
}) {
  const roleById = new Map(roles.map((role) => [role._id, role]));
  return <section className="subagent-panel"><h2>Subagents</h2><div className="subagent-layout">
    <div className="role-roster" aria-label="Role roster">{roles.map((role) => <details key={role._id}>
      <summary>{role.name}<span>{role.writer ? "Writer" : "Read only"}</span></summary><p>{role.description}</p>
      <label>Description<input aria-label={`${role.name} description`} defaultValue={role.description} onBlur={(event) => onUpdateRole({ description: event.currentTarget.value, roleId: role._id })} /></label>
      <label>Prompt<textarea aria-label={`${role.name} prompt`} defaultValue={role.prompt} onBlur={(event) => onUpdateRole({ prompt: event.currentTarget.value, roleId: role._id })} /></label>
      <label>Model<input aria-label={`${role.name} model`} defaultValue={role.modelId} onBlur={(event) => onUpdateRole({ modelId: event.currentTarget.value, roleId: role._id })} /></label>
      <label>Thinking<select aria-label={`${role.name} thinking`} defaultValue={role.thinkingLevel} onChange={(event) => onUpdateRole({ roleId: role._id, thinkingLevel: event.currentTarget.value as ThinkingLevel })}><option value="none">None</option><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></select></label>
      <label>Max turns<input aria-label={`${role.name} max turns`} defaultValue={role.maxTurns} min="1" max="100" onBlur={(event) => onUpdateRole({ maxTurns: Number(event.currentTarget.value), roleId: role._id })} type="number" /></label>
      <label>Context<select aria-label={`${role.name} context`} defaultValue={role.contextMode} onChange={(event) => onUpdateRole({ contextMode: event.currentTarget.value as "fresh" | "forked", roleId: role._id })}><option value="fresh">Fresh</option><option value="forked">Forked</option></select></label>
      <label><input checked={role.writer} onChange={(event) => onUpdateRole({ roleId: role._id, writer: event.currentTarget.checked })} type="checkbox" />Writer</label>
      <div className="role-capabilities">{(["read", "edit", "exec", "task"] satisfies Capability[]).map((capability) => <label key={capability}><input checked={role.capabilities.includes(capability)} onChange={(event) => onUpdateRole({ capabilities: event.currentTarget.checked ? [...role.capabilities, capability] : role.capabilities.filter((item) => item !== capability), roleId: role._id })} type="checkbox" />{capability}</label>)}</div>
      <p className="role-meta">{role.contextMode} context · {role.capabilities.join(", ")}</p>
    </details>)}</div>
    <div className="subagent-tree" aria-label="Subagent tree">{runs.length === 0 ? <p>No subagent runs.</p> : runs.map((run) => <details key={run._id} open={run.depth === 1} style={{ marginLeft: `${(run.depth - 1) * 16}px` }}>
      <summary>{roleById.get(run.roleId)?.name ?? "Subagent"}<span>{run.status}</span></summary><p>{run.task}</p>
      {run.result ? <><p>{run.result.summary}</p>{run.result.findings.map((finding) => <code key={finding}>{finding}</code>)}{run.result.artifacts.map((artifact) => <code key={artifact}>{artifact}</code>)}</> : null}
    </details>)}</div>
  </div></section>;
}
