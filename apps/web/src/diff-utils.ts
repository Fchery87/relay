export type DiffComment = { _id: string; content: string; endLine: number; filePath: string; resolved: boolean; startLine: number };

export type FileChangeKind = "added" | "modified" | "deleted" | "renamed";

export type ParsedFile = {
  content: string;
  name: string;
  kind: FileChangeKind;
  additions: number;
  deletions: number;
};

export type DiffSummary = {
  fileCount: number;
  additions: number;
  deletions: number;
};

export const FILE_KIND_LABEL: Record<FileChangeKind, string> = {
  added: "A",
  deleted: "D",
  modified: "M",
  renamed: "R",
};

export function groupCommentsByFile(comments: DiffComment[]): Map<string, DiffComment[]> {
  const grouped = new Map<string, DiffComment[]>();
  for (const comment of comments) {
    const fileComments = grouped.get(comment.filePath);
    if (fileComments) fileComments.push(comment);
    else grouped.set(comment.filePath, [comment]);
  }
  return grouped;
}

export function isReviewableDiff(content: string): boolean {
  return /^diff --git /m.test(content);
}

/** Count single-line additions (+) and deletions (−) in a git patch fragment. */
export function parseFileStats(patch: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) additions++;
    else if (line.startsWith("-")) deletions++;
  }
  return { additions, deletions };
}

/** Resolve the semantic change kind from the git patch headers. */
export function resolveFileKind(patch: string): FileChangeKind {
  if (/^new file mode\b/m.test(patch)) return "added";
  if (/^deleted file mode\b/m.test(patch)) return "deleted";
  if (/^rename from\b/m.test(patch) || /^rename to\b/m.test(patch)) return "renamed";
  return "modified";
}

export function splitFiles(content: string): ParsedFile[] {
  const starts = [...content.matchAll(/^diff --git /gm)].map((match) => match.index);
  if (starts.length === 0) return [];
  return starts.map((start, index) => {
    const patch = content.slice(start, starts[index + 1] ?? content.length).trimEnd();
    const name = /^\+\+\+ b\/(.+)$/m.exec(patch)?.[1] ?? /^diff --git a\/.+ b\/(.+)$/m.exec(patch)?.[1] ?? "Changed file";
    const { additions, deletions } = parseFileStats(patch);
    return { content: patch, name, kind: resolveFileKind(patch), additions, deletions };
  });
}

export function summarizeFiles(files: readonly ParsedFile[]): DiffSummary {
  let additions = 0;
  let deletions = 0;
  for (const file of files) {
    additions += file.additions;
    deletions += file.deletions;
  }
  return { fileCount: files.length, additions, deletions };
}
