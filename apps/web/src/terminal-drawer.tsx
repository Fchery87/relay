import type { FormEvent } from "react";

import { ThreadActivity, ThreadTerminal, type ThreadEvent } from "./thread-activity";

export function TerminalDrawer({
  command,
  events,
  onCommandChange,
  onSubmitCommand,
  open,
}: {
  command: string;
  events: ReadonlyArray<ThreadEvent>;
  onCommandChange: (command: string) => void;
  onSubmitCommand: (event: FormEvent) => Promise<void>;
  open: boolean;
}) {
  if (!open) return null;
  return (
    <section aria-label="Terminal drawer" className="terminal-drawer">
      <div className="activity-layout terminal-workspace">
        <ThreadActivity events={[...events]} />
        <ThreadTerminal events={[...events]}>
          <form className="command-form" onSubmit={(event) => void onSubmitCommand(event)}>
            <input aria-label="Command" onChange={(event) => onCommandChange(event.target.value)} placeholder="Run a command in this worktree" value={command} />
            <button className="button-primary" type="submit">Run</button>
          </form>
        </ThreadTerminal>
      </div>
    </section>
  );
}
