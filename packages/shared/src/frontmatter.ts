export interface FrontmatterDocument {
  attributes: Record<string, string>;
  body: string;
}

export function parseFrontmatter(source: string): FrontmatterDocument {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(source);
  const frontmatter = match?.[1];
  if (!match || frontmatter === undefined) return { attributes: {}, body: source };
  const attributes: Record<string, string> = {};
  for (const line of frontmatter.split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (key) attributes[key] = value;
  }
  return { attributes, body: source.slice(match[0].length) };
}
