import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { WorkspaceSidebar, type SidebarProject } from "./workspace-sidebar";

const projects: SidebarProject[] = [
  { id: "p1", machineName: "mbp", name: "relay", path: "/repo/relay", presence: "online" },
  { id: "p2", machineName: "desktop", name: "photogenic", path: "/repo/photo", presence: "offline" },
];

test("renders brand, search trigger, projects with machine presence, and settings link", () => {
  const markup = renderToStaticMarkup(
    <WorkspaceSidebar activeProjectId="p1" attention={[]} projects={projects} renderRuns={(projectId) => <span>runs-for-{projectId}</span>} />,
  );

  expect(markup).toContain('data-relay-mark="switchboard"');
  expect(markup).toContain("Search");
  expect(markup).toContain("⌘K");
  expect(markup).toContain("relay");
  expect(markup).toContain("photogenic");
  expect(markup).toContain("presence-online");
  expect(markup).toContain("presence-offline");
  expect(markup).toContain("runs-for-p1");
  expect(markup).not.toContain("runs-for-p2");
  expect(markup).toContain("Settings");
  expect(markup).not.toContain("Disconnect");
});

test("shows the brass attention inbox only when runs need the operator", () => {
  const empty = renderToStaticMarkup(<WorkspaceSidebar activeProjectId={undefined} attention={[]} projects={projects} renderRuns={() => null} />);
  expect(empty).not.toContain("Needs you");

  const busy = renderToStaticMarkup(
    <WorkspaceSidebar
      activeProjectId={undefined}
      attention={[
        { kind: "approval", projectId: "p1", projectName: "relay", threadId: "t1", title: "Fix auth" },
        { kind: "plan-review", projectId: "p1", projectName: "relay", threadId: "t2", title: "Refactor" },
      ]}
      projects={projects}
      renderRuns={() => null}
    />,
  );
  expect(busy).toContain("Needs you");
  expect(busy).toContain("Fix auth");
  expect(busy).toContain("approval");
  expect(busy).toContain("plan review");
  expect(busy).toContain("needs-you-badge");
});

test("marks the active project and offers a new task per project", () => {
  const markup = renderToStaticMarkup(
    <WorkspaceSidebar activeProjectId="p1" attention={[]} projects={projects} renderRuns={() => null} />,
  );
  expect(markup).toContain('aria-current="true"');
  expect(markup).toContain("New task");
});
