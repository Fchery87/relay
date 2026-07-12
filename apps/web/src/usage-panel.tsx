import type { FormEvent } from "react";

export type UsageRecord = {
  _creationTime: number;
  _id: string;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  callId: string;
  costUsd: number;
  inputTokens: number;
  messageId: string;
  modelId: string;
  outputTokens: number;
  role: string;
  thinkingTokens: number | null;
  threadId: string;
};

export type UsageSummary = {
  budgetUsd: number | null;
  records: UsageRecord[];
  totals: {
    cacheReadTokens: number;
    cacheWriteTokens: number;
    costUsd: number;
    inputTokens: number;
    outputTokens: number;
    thinkingTokens: number;
    thinkingTokensUnavailableCalls: number;
  };
  truncated: boolean;
};

export const EMPTY_USAGE_SUMMARY: UsageSummary = {
  budgetUsd: null,
  records: [],
  totals: { cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, inputTokens: 0, outputTokens: 0, thinkingTokens: 0, thinkingTokensUnavailableCalls: 0 },
  truncated: false,
};

const tokenFormatter = new Intl.NumberFormat("en-US");

export function UsagePanel({ onBudgetChange, value }: { onBudgetChange?: (budgetUsd: number | null) => Promise<unknown>; value: UsageSummary }) {
  const { budgetUsd, records, totals, truncated } = value;
  const totalTokens = totals.inputTokens + totals.outputTokens;
  const cacheHitRate = totals.inputTokens === 0 ? 0 : Math.round((totals.cacheReadTokens / totals.inputTokens) * 100);
  const budgetExceeded = budgetUsd !== null && totals.costUsd >= budgetUsd;

  return <details className="usage-panel">
    <summary aria-live="polite">
      <strong>{formatCost(totals.costUsd)}</strong>
      <span>{tokenFormatter.format(totalTokens)} tokens</span>
      <span>{cacheHitRate}% cache hit</span>
      {budgetExceeded ? <span className="usage-warning">Budget exceeded</span> : null}
    </summary>
    <div className="usage-breakdown">
      {onBudgetChange ? <BudgetForm budgetUsd={budgetUsd} onChange={onBudgetChange} /> : null}
      {truncated ? <p className="usage-truncated">Showing the latest 200 calls.</p> : null}
      {records.length === 0 ? <p>No completed turns.</p> : <table>
        <thead><tr><th>Model</th><th>Role</th><th>Tokens</th><th>Cache</th><th>Cost</th></tr></thead>
        <tbody>{records.map((record) => <tr key={record._id}>
          <td><code>{record.modelId}</code></td>
          <td>{record.role}</td>
          <td>{tokenFormatter.format(record.inputTokens)} in / {tokenFormatter.format(record.outputTokens)} out{record.thinkingTokens === null ? " / thinking unavailable" : record.thinkingTokens > 0 ? ` / ${tokenFormatter.format(record.thinkingTokens)} thinking` : ""}</td>
          <td>{tokenFormatter.format(record.cacheReadTokens)} read / {tokenFormatter.format(record.cacheWriteTokens)} write</td>
          <td>{formatCost(record.costUsd)}</td>
        </tr>)}</tbody>
      </table>}
    </div>
  </details>;
}

function BudgetForm({ budgetUsd, onChange }: { budgetUsd: number | null; onChange: (budgetUsd: number | null) => Promise<unknown> }) {
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = new FormData(event.currentTarget).get("budgetUsd");
    if (typeof value !== "string") return;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return;
    await onChange(parsed);
  }

  return <form className="budget-form" onSubmit={(event) => void submit(event)}>
    <input aria-label="Budget in USD" defaultValue={budgetUsd ?? ""} min="0.01" name="budgetUsd" placeholder="Budget USD" step="0.01" type="number" />
    <button type="submit">Set budget</button>
    {budgetUsd !== null ? <button onClick={() => void onChange(null)} type="button">Clear budget</button> : null}
  </form>;
}

function formatCost(costUsd: number): string {
  const rounded = Math.round((costUsd + Number.EPSILON) * 10_000) / 10_000;
  return `$${rounded.toFixed(4)}`;
}
