import { createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import type { ComponentType } from "react";
import type { RouteComponent } from "@tanstack/react-router";

export type WorkbenchView = "session" | "changes" | "plan";

export type WorkspaceSearch = {
  view?: WorkbenchView;
};

/** Narrow any historical or hand-typed ?view= value to a canvas the shell still renders. */
export function resolveWorkbenchView(view: unknown): WorkbenchView | undefined {
  return view === "session" || view === "changes" || view === "plan" ? view : undefined;
}

// Unknown raw values survive validation in this router version (raw search is
// spread under the validated result), so consumers must narrow with
// resolveWorkbenchView instead of trusting the declared type.
function validateWorkspaceSearch(search: Record<string, unknown>): WorkspaceSearch {
  const view = resolveWorkbenchView(search.view);
  return view === undefined ? {} : { view };
}

export function createRelayRouter(Workspace: ComponentType, Settings: ComponentType = Workspace) {
  const WorkspaceRoute = Workspace as RouteComponent;
  const SettingsRoute = Settings as RouteComponent;
  const rootRoute = createRootRoute();
  const indexRoute = createRoute({ component: WorkspaceRoute, getParentRoute: () => rootRoute, path: "/", validateSearch: validateWorkspaceSearch });
  const projectRoute = createRoute({ component: WorkspaceRoute, getParentRoute: () => rootRoute, path: "/projects/$projectId", validateSearch: validateWorkspaceSearch });
  const runRoute = createRoute({ component: WorkspaceRoute, getParentRoute: () => rootRoute, path: "/projects/$projectId/threads/$threadId", validateSearch: validateWorkspaceSearch });
  const settingsRoute = createRoute({ component: SettingsRoute, getParentRoute: () => rootRoute, path: "/settings" });
  const settingsSectionRoute = createRoute({ component: SettingsRoute, getParentRoute: () => rootRoute, path: "/settings/$section" });
  return createRouter({ routeTree: rootRoute.addChildren([indexRoute, projectRoute, runRoute, settingsRoute, settingsSectionRoute]) });
}
