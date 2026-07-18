import type { ReactNode } from "react";
import { DEFAULT_MODEL_ID, MODEL_CATALOG } from "@relay/shared";

import { DensityControl } from "./density-control";
import { machinePresence } from "@relay/shared";
import type { MachineSummary } from "./run-data";

export type SettingsSection = "account" | "appearance" | "models" | "machines" | "agents" | "shortcuts" | "connections" | "budgets";

const GLOBAL_SECTIONS: ReadonlyArray<{ id: SettingsSection; label: string }> = [
  { id: "account", label: "Account" },
  { id: "appearance", label: "Appearance" },
  { id: "models", label: "Models" },
  { id: "machines", label: "Machines" },
  { id: "agents", label: "Agents" },
  { id: "shortcuts", label: "Shortcuts" },
];

const PROJECT_SECTIONS: ReadonlyArray<{ id: SettingsSection; label: string }> = [
  { id: "connections", label: "Connections" },
  { id: "budgets", label: "Budgets" },
];

const SHORTCUTS: ReadonlyArray<{ action: string; keys: string }> = [
  { action: "Toggle sidebar", keys: "⌘B" },
  { action: "Toggle terminal drawer", keys: "⌘J" },
  { action: "Toggle inspector", keys: "⌘I" },
  { action: "Command palette", keys: "⌘K" },
  { action: "Send directive", keys: "⌘Enter" },
];

const OFFLINE_AFTER_MS = 30_000;
const PLATFORM_LABELS: Record<MachineSummary["platform"], string> = { darwin: "macOS", linux: "Linux", win32: "Windows" };

export function resolveSettingsSection(section: string | undefined): SettingsSection {
  const known = [...GLOBAL_SECTIONS, ...PROJECT_SECTIONS].find((entry) => entry.id === section);
  return known?.id ?? "account";
}

export function SettingsView({
  agentsContent,
  connectionsContent,
  email,
  machines,
  now,
  onBack,
  onNavigateSection,
  onRevoke,
  onSignOut,
  pairingContent,
  projectName,
  section,
}: {
  agentsContent: ReactNode;
  connectionsContent: ReactNode;
  email: string | undefined;
  machines: ReadonlyArray<MachineSummary>;
  now: number;
  onBack?: () => void;
  onNavigateSection?: (section: SettingsSection) => void;
  onRevoke?: (machineId: string) => Promise<void>;
  onSignOut?: () => Promise<void>;
  pairingContent: ReactNode;
  projectName: string | undefined;
  section: SettingsSection;
}) {
  const defaultModel = MODEL_CATALOG.models.find((model) => model.id === DEFAULT_MODEL_ID);

  return (
    <div className="settings-layout">
      <nav aria-label="Settings sections" className="settings-rail">
        <button className="settings-back" onClick={() => onBack?.()} type="button">← Back</button>
        <p className="settings-scope">Global</p>
        {GLOBAL_SECTIONS.map((entry) => (
          <button aria-current={entry.id === section ? "true" : undefined} key={entry.id} onClick={() => onNavigateSection?.(entry.id)} type="button">{entry.label}</button>
        ))}
        <p className="settings-scope">Project{projectName ? ` · ${projectName}` : ""}</p>
        {PROJECT_SECTIONS.map((entry) => (
          <button aria-current={entry.id === section ? "true" : undefined} key={entry.id} onClick={() => onNavigateSection?.(entry.id)} type="button">{entry.label}</button>
        ))}
      </nav>
      <section aria-live="polite" className="settings-content">
        {section === "account" ? (
          <div className="settings-section">
            <h2>Account</h2>
            <dl className="settings-facts"><div><dt>Signed in as</dt><dd>{email ?? "Unknown"}</dd></div></dl>
            {onSignOut ? <button onClick={() => void onSignOut()} type="button">Sign out</button> : <button type="button">Sign out</button>}
          </div>
        ) : null}
        {section === "appearance" ? (
          <div className="settings-section">
            <h2>Appearance</h2>
            <p className="settings-hint">Density changes control and row heights without changing what is shown.</p>
            <DensityControl />
          </div>
        ) : null}
        {section === "models" ? (
          <div className="settings-section">
            <h2>Models</h2>
            <dl className="settings-facts">
              <div><dt>Default model</dt><dd>{defaultModel?.name ?? DEFAULT_MODEL_ID}</dd></div>
              <div><dt>Catalog</dt><dd>{MODEL_CATALOG.models.length} models across {new Set(MODEL_CATALOG.models.map((model) => model.provider)).size} providers</dd></div>
            </dl>
            <p className="settings-hint">Pick the model per run from the composer; plan runs configure a plan/build pair in the Plan tab.</p>
          </div>
        ) : null}
        {section === "machines" ? (
          <div className="settings-section">
            <h2>Machines</h2>
            <ul className="settings-machines">
              {machines.map((machine) => {
                const presence = machinePresence({ heartbeatAt: machine.lastHeartbeatAt, now, offlineAfterMs: OFFLINE_AFTER_MS });
                return (
                  <li key={machine.id}>
                    <span className={`presence presence-${presence}`} aria-hidden="true" />
                    <div>
                      <strong>{machine.name}</strong>
                      <small>{PLATFORM_LABELS[machine.platform]} · {presence === "online" ? "Online" : "Offline"} · ceiling: {machine.capabilityCeiling && machine.capabilityCeiling.length > 0 ? machine.capabilityCeiling.join(" · ") : "policy default"}</small>
                    </div>
                    {onRevoke ? <button onClick={() => void onRevoke(machine.id)} type="button">Revoke</button> : <button type="button">Revoke</button>}
                  </li>
                );
              })}
            </ul>
            <h3>Pair a new machine</h3>
            {pairingContent}
          </div>
        ) : null}
        {section === "agents" ? (
          <div className="settings-section">
            <h2>Agents</h2>
            <p className="settings-hint">Role definitions apply to every project. Live delegated runs appear in the inspector.</p>
            {agentsContent}
          </div>
        ) : null}
        {section === "shortcuts" ? (
          <div className="settings-section">
            <h2>Shortcuts</h2>
            <table className="settings-shortcuts">
              <tbody>
                {SHORTCUTS.map((shortcut) => (
                  <tr key={shortcut.keys}><td>{shortcut.action}</td><td><kbd>{shortcut.keys}</kbd></td></tr>
                ))}
              </tbody>
            </table>
            <p className="settings-hint">⌘ is Ctrl on Linux and Windows.</p>
          </div>
        ) : null}
        {section === "connections" ? (
          <div className="settings-section">
            <h2>Connections</h2>
            {connectionsContent}
          </div>
        ) : null}
        {section === "budgets" ? (
          <div className="settings-section">
            <h2>Budgets</h2>
            <p className="settings-hint">Budgets are set per run: open a run and use the inspector's Usage section. A run pauses for your approval when it reaches its budget.</p>
          </div>
        ) : null}
      </section>
    </div>
  );
}
