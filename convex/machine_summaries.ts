export function toProjectSummary({
  _id,
  archivedAt,
  error,
  name,
  path,
  status,
}: {
  _id: string;
  archivedAt?: number;
  error?: string;
  name: string;
  path: string;
  status?: string;
}): { archivedAt?: number; error?: string; id: string; name: string; path: string; status?: string } {
  return { archivedAt, error, id: _id, name, path, status };
}
