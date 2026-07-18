import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { resolveSettingsSection, SettingsView } from "./settings-view";
import type { MachineSummary } from "./run-data";

const machines: MachineSummary[] = [
  { capabilityCeiling: ["read", "edit"], id: "m1", lastHeartbeatAt: 1_000, name: "mbp", platform: "darwin", projects: [{ id: "p1", name: "relay", path: "/repo" }] },
];

function render(section: string | undefined) {
  return renderToStaticMarkup(
    <SettingsView
      agentsContent={<p>agents-slot</p>}
      connectionsContent={<p>connections-slot</p>}
      email="fchery87@gmail.com"
      machines={machines}
      now={10_000}
      pairingContent={<p>pairing-slot</p>}
      projectName="relay"
      section={resolveSettingsSection(section)}
    />,
  );
}

test("unknown sections fall back to account", () => {
  expect(resolveSettingsSection(undefined)).toBe("account");
  expect(resolveSettingsSection("nope")).toBe("account");
  expect(resolveSettingsSection("machines")).toBe("machines");
});

test("renders the section rail with global and project scopes", () => {
  const markup = render("account");
  expect(markup).toContain("Account");
  expect(markup).toContain("Appearance");
  expect(markup).toContain("Models");
  expect(markup).toContain("Machines");
  expect(markup).toContain("Agents");
  expect(markup).toContain("Shortcuts");
  expect(markup).toContain("Connections");
  expect(markup).toContain("Budgets");
  expect(markup).toContain("fchery87@gmail.com");
  expect(markup).toContain("Sign out");
});

test("machines section lists machines with revoke and pairing", () => {
  const markup = render("machines");
  expect(markup).toContain("mbp");
  expect(markup).toContain("macOS");
  expect(markup).toContain("read · edit");
  expect(markup).toContain("Revoke");
  expect(markup).toContain("pairing-slot");
});

test("appearance hosts density and shortcuts lists the toggle keys", () => {
  expect(render("appearance")).toContain("Density");
  const shortcuts = render("shortcuts");
  expect(shortcuts).toContain("⌘B");
  expect(shortcuts).toContain("⌘J");
  expect(shortcuts).toContain("⌘I");
  expect(shortcuts).toContain("⌘K");
});
