import { useEffect, useRef, useState } from "react";

import type { PermissionProfile } from "./run-data";

export type { PermissionProfile };

const PROFILES: ReadonlyArray<{ description: string; id: PermissionProfile; label: string; warning?: string }> = [
  { description: "Inspect only — no writes, no commands", id: "read-only", label: "Read-only" },
  { description: "Edit inside the worktree · network denied", id: "workspace-write", label: "Workspace write" },
  { description: "Full access — auto-approves all tools, including critical commands", id: "full-access", label: "Full access", warning: "⚠ Network enabled" },
];

export function AccessPicker({
  defaultOpen = false,
  disabled = false,
  onChange,
  value,
}: {
  defaultOpen?: boolean;
  disabled?: boolean;
  onChange: (profile: PermissionProfile) => Promise<unknown>;
  value: PermissionProfile;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const containerRef = useRef<HTMLDivElement>(null);
  const active = PROFILES.find((profile) => profile.id === value) ?? PROFILES[1]!;

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (containerRef.current && event.target instanceof Node && !containerRef.current.contains(event.target)) setOpen(false);
    }
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  return (
    <div className="composer-picker" onKeyDown={(event) => { if (event.key === "Escape") setOpen(false); }} ref={containerRef}>
      <button
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label="Access"
        className="composer-picker-trigger"
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
        title={disabled ? "Locked while a turn is running" : undefined}
        type="button"
      >
        <span aria-hidden="true">▣</span> {active.label} <span aria-hidden="true">▾</span>
      </button>
      {disabled ? <span className="visually-hidden">Locked while a turn is running</span> : null}
      {open && !disabled ? (
        <div className="composer-popover" role="listbox" aria-label="Permission profiles">
          {PROFILES.map((profile) => (
            <button
              aria-selected={profile.id === value}
              className="composer-popover-option"
              key={profile.id}
              onClick={() => {
                void onChange(profile.id);
                setOpen(false);
              }}
              role="option"
              type="button"
            >
              <strong>{profile.label}</strong>
              <small>{profile.description}</small>
              {profile.warning ? <small className="composer-popover-warning">{profile.warning}</small> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
