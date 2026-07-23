export type JurySeverity = "P0" | "P1" | "P2" | "P3";

export type JuryFinding = Readonly<{
  severity: JurySeverity;
  title: string;
  detail: string;
  source: string;
  filePath?: string;
  startLine?: number;
  endLine?: number;
}>;

const SEVERITY_ORDER: Record<JurySeverity, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };

/** Prompt contract shared by the two independent reviewers in the jury. */
export const REVIEW_JURY_FINDINGS_FORMAT = [
  "Report findings only in this machine-readable section:",
  "FINDINGS:",
  "- P1 | short title | concrete detail | path/to/file.ts:12-14",
  "Use P0 for a release-blocking issue and P3 for a minor issue.",
  "If there are no findings, write `FINDINGS: none`.",
].join("\n");

/** Parse one reviewer’s bounded result summary into canonical jury findings. */
export function parseJuryFindings(summary: string, source: string): readonly JuryFinding[] {
  const findings: JuryFinding[] = [];
  for (const line of summary.split(/\r?\n/)) {
    const match = line.match(/^\s*[-*]\s*(P[0-3])\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*(?:\|\s*(\S+))?\s*$/i);
    if (!match) continue;
    const severity = match[1]!.toUpperCase() as JurySeverity;
    const location = parseLocation(match[4]);
    findings.push({
      severity,
      title: match[2]!.trim().slice(0, 200),
      detail: match[3]!.trim().slice(0, 2_000),
      source,
      ...(location ?? {}),
    });
  }
  return findings;
}

/** Merge independent reviewer output deterministically and remove duplicates. */
export async function runReviewJury(
  reviewers: readonly ((runId: string) => Promise<readonly JuryFinding[]>)[],
  runId: string,
): Promise<readonly JuryFinding[]> {
  const results = await Promise.all(reviewers.map((review) => review(runId)));
  return mergeJuryFindings(results.flat());
}

export function mergeJuryFindings(findings: readonly JuryFinding[]): readonly JuryFinding[] {
  const unique = new Map<string, JuryFinding>();
  for (const finding of findings) {
    const key = `${finding.severity}:${finding.title.toLowerCase()}:${finding.detail.toLowerCase()}`;
    if (!unique.has(key)) unique.set(key, finding);
  }
  return [...unique.values()].sort((a, b) =>
    SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
    a.title.localeCompare(b.title) ||
    a.source.localeCompare(b.source),
  );
}

export function juryFindingToReviewComment(finding: JuryFinding, index: number): Readonly<{
  commentId: string;
  content: string;
  endLine: number;
  filePath: string;
  startLine: number;
}> {
  return {
    commentId: `jury-${finding.severity.toLowerCase()}-${index + 1}`,
    content: `[${finding.severity}] ${finding.title}: ${finding.detail} (source: ${finding.source})`,
    endLine: finding.endLine ?? finding.startLine ?? 1,
    filePath: finding.filePath ?? "WORKFLOW",
    startLine: finding.startLine ?? 1,
  };
}

function parseLocation(value: string | undefined): Pick<JuryFinding, "filePath" | "startLine" | "endLine"> | undefined {
  if (!value) return undefined;
  const match = value.match(/^(.+):(\d+)(?:-(\d+))?$/);
  if (!match) return undefined;
  const startLine = Number(match[2]);
  const endLine = Number(match[3] ?? match[2]);
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1 || endLine < startLine) return undefined;
  return { filePath: match[1]!, startLine, endLine };
}
