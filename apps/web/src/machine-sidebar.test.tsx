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
