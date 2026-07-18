import { MODEL_CATALOG } from "@relay/shared";

export type CatalogModel = (typeof MODEL_CATALOG.models)[number];

export function groupModelsByProvider(models: ReadonlyArray<CatalogModel>): Array<{ models: CatalogModel[]; provider: string }> {
  const groups: Array<{ models: CatalogModel[]; provider: string }> = [];
  for (const model of models) {
    const group = groups.find((entry) => entry.provider === model.provider);
    if (group) group.models.push(model);
    else groups.push({ models: [model], provider: model.provider });
  }
  return groups;
}
