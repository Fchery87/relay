export function toProjectSummary({
  _id,
  archivedAt,
  name,
  path,
}: {
  _id: string;
  archivedAt?: number;
  name: string;
  path: string;
}): { archivedAt?: number; id: string; name: string; path: string } {
  return { archivedAt, id: _id, name, path };
}
