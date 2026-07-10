export function toProjectSummary({
  _id,
  name,
  path,
}: {
  _id: string;
  name: string;
  path: string;
}): { id: string; name: string; path: string } {
  return { id: _id, name, path };
}
