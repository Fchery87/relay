import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { UnconfiguredWorkspace } from "./app";
import { MachineSidebar } from "./machine-sidebar";

test("shows a machine as offline once its heartbeat expires", () => {
  const markup = renderToStaticMarkup(
    <MachineSidebar
      machines={[
        {
          id: "machine-1",
          lastHeartbeatAt: 1_000,
          name: "dev-machine",
          platform: "linux",
          projects: [{ id: "project-1", name: "relay", path: "/workspace/relay" }],
        },
      ]}
      now={31_000}
    />,
  );

  expect(markup).toContain("Offline");
  expect(markup).toContain("relay");
});

test("explains how to configure the web client", () => {
  expect(renderToStaticMarkup(<UnconfiguredWorkspace />)).toContain("VITE_CONVEX_URL");
});

test("renders a disconnect control for each machine", () => {
  const markup = renderToStaticMarkup(<MachineSidebar machines={[{
    id: "machine-1", lastHeartbeatAt: 1_000, name: "dev-machine", platform: "linux", projects: [],
  }]} now={1_000} onRevoke={async () => undefined} />);
  expect(markup).toContain("Disconnect");
});

test("keeps machine navigation legible when no daemon is connected", () => {
  const markup = renderToStaticMarkup(<MachineSidebar machines={[]} now={0} />);

  expect(markup).toContain("Machines");
  expect(markup).toContain("No machines connected");
});

test("shows the machine platform beside its connection state", () => {
  const markup = renderToStaticMarkup(<MachineSidebar machines={[{
    id: "machine-1", lastHeartbeatAt: 1_000, name: "workstation", platform: "linux", projects: [],
  }]} now={1_000} />);

  expect(markup).toContain("Linux");
  expect(markup).toContain("Online");
});

test("marks the selected project and exposes compact mobile navigation", () => {
  const markup = renderToStaticMarkup(<MachineSidebar machines={[{
    id: "machine-1", lastHeartbeatAt: 1_000, name: "workstation", platform: "linux", projects: [
      { id: "project-1", name: "relay", path: "/workspace/relay" },
      { id: "project-2", name: "docs", path: "/workspace/docs" },
    ],
  }]} now={1_000} selectedProjectId="project-2" />);

  expect(markup).toContain('aria-current="page"');
  expect(markup).toContain('aria-expanded="false"');
  expect(markup).toContain("docs");
});
