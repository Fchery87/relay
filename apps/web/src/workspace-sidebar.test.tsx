import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { WorkspaceSidebar, type SidebarProject } from "./workspace-sidebar";

const projects: SidebarProject[] = [
  { id: "p1", machineId: "m1", machineName: "mbp", name: "relay", path: "/repo/relay", presence: "online" },
  { id: "p2", machineId: "m2", machineName: "desktop", name: "photogenic", path: "/repo/photo", presence: "offline" },
  { id: "p3", machineId: "m1", machineName: "mbp", name: "pending-proj", path: "/repo/pending", presence: "online", status: "pending" },
  { id: "p4", machineId: "m2", machineName: "desktop", name: "bad-proj", path: "/repo/bad", presence: "offline", status: "error", error: "path not found" },
  { id: "p5", machineId: "m1", machineName: "mbp", name: "old-proj", path: "/repo/old", presence: "offline", archivedAt: 1700000000000 },
];

test("renders brand, search trigger, projects with machine presence, and settings link", () => {
  const markup = renderToStaticMarkup(
    <WorkspaceSidebar activeProjectId="p1" attention={[]} projects={projects} renderRuns={(projectId) => <span>runs-for-{projectId}</span>} />,
  );

  expect(markup).toContain("Relay");
  expect(markup).toContain("Search");
  expect(markup).toContain("⌘K");
  expect(markup).toContain("relay");
  expect(markup).toContain("photogenic");
  expect(markup).toContain("presence-online");
  expect(markup).toContain("presence-offline");
  expect(markup).toContain("runs-for-p1");
  expect(markup).not.toContain("runs-for-p2");
  expect(markup).toContain("Settings");
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
});

test("marks the active project and offers a new task per project", () => {
  const markup = renderToStaticMarkup(
    <WorkspaceSidebar activeProjectId="p1" attention={[]} projects={projects} renderRuns={() => null} />,
  );
  expect(markup).toContain('aria-current="true"');
  expect(markup).toContain("New task");
});

test("renders an Add project button per machine group", () => {
  const markup = renderToStaticMarkup(
    <WorkspaceSidebar
      activeProjectId={undefined}
      attention={[]}
      onAddProject={() => {}}
      projects={projects}
      renderRuns={() => null}
    />,
  );
  expect(markup).toContain("+ Add project");
  // Two unique machines → at least two add project triggers
  const addButtons = markup.split("+ Add project").length - 1;
  expect(addButtons).toBeGreaterThanOrEqual(2);
});

test("renders status badges for pending, error, and archived projects", () => {
  const markup = renderToStaticMarkup(
    <WorkspaceSidebar activeProjectId={undefined} attention={[]} projects={projects} renderRuns={() => null} />,
  );
  expect(markup).toContain("project-badge-pending");
  expect(markup).toContain("pending");
  expect(markup).toContain("project-badge-error");
  expect(markup).toContain("path not found");
  expect(markup).toContain("project-badge-archived");
  expect(markup).toContain("archived");
});

test("archived projects get greyed styling", () => {
  const markup = renderToStaticMarkup(
    <WorkspaceSidebar activeProjectId={undefined} attention={[]} projects={projects} renderRuns={() => null} />,
  );
  expect(markup).toContain("project-archived");
});

test("does not render Add project button when onAddProject is not provided", () => {
  const markup = renderToStaticMarkup(
    <WorkspaceSidebar activeProjectId={undefined} attention={[]} projects={projects} renderRuns={() => null} />,
  );
  expect(markup).not.toContain("+ Add project");
});
