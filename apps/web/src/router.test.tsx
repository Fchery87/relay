import { expect, test } from "bun:test";
import { createMemoryHistory } from "@tanstack/react-router";

import { createRelayRouter, resolveWorkbenchView } from "./router";

function Workspace() {
  return null;
}

test("parses deep project, thread, and canvas state from the URL", async () => {
  const history = createMemoryHistory({ initialEntries: ["/projects/project-1/threads/thread-9?view=changes"] });
  const router = createRelayRouter(Workspace);
  router.update({ history });
  await router.load();

  expect(router.state.location.pathname).toBe("/projects/project-1/threads/thread-9");
  expect(router.state.location.search).toEqual({ view: "changes" });
  expect(router.state.matches.at(-1)?.params).toEqual({ projectId: "project-1", threadId: "thread-9" });
});

test("legacy canvas views still match their route and narrow to no view", async () => {
  const history = createMemoryHistory({ initialEntries: ["/projects/project-1?view=terminal"] });
  const router = createRelayRouter(Workspace);
  router.update({ history });
  await router.load();

  expect(router.state.matches.at(-1)?.params).toEqual({ projectId: "project-1" });
  expect(resolveWorkbenchView("terminal")).toBeUndefined();
  expect(resolveWorkbenchView("connections")).toBeUndefined();
  expect(resolveWorkbenchView("changes")).toBe("changes");
});

test("resolves settings routes with an optional section", async () => {
  const history = createMemoryHistory({ initialEntries: ["/settings/machines"] });
  const router = createRelayRouter(Workspace, Workspace);
  router.update({ history });
  await router.load();

  expect(router.state.location.pathname).toBe("/settings/machines");
  expect(router.state.matches.at(-1)?.params).toEqual({ section: "machines" });

  const rootHistory = createMemoryHistory({ initialEntries: ["/settings"] });
  const rootRouter = createRelayRouter(Workspace, Workspace);
  rootRouter.update({ history: rootHistory });
  await rootRouter.load();
  expect(rootRouter.state.location.pathname).toBe("/settings");
});

test("accepts project routes without requiring a run", async () => {
  const history = createMemoryHistory({ initialEntries: ["/projects/project-1"] });
  const router = createRelayRouter(Workspace);
  router.update({ history });
  await router.load();

  expect(router.state.location.pathname).toBe("/projects/project-1");
  expect(router.state.matches.at(-1)?.params).toEqual({ projectId: "project-1" });
});
