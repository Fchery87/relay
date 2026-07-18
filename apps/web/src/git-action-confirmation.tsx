import { useEffect, useRef } from "react";

export type GitAction = "stage" | "commit" | "push";

const ACTION_COPY: Record<GitAction, { title: string; description: string; confirm: string }> = {
  stage: { title: "Stage worktree changes", description: "Relay will stage all tracked and untracked files in the active isolated worktree.", confirm: "Stage all files" },
  commit: { title: "Create a commit", description: "Relay will create a commit from the currently staged files using the message below.", confirm: "Create commit" },
  push: { title: "Push changes", description: "Relay will push the current branch through its configured upstream. Verify the repository and branch before continuing.", confirm: "Push changes" },
};

export function GitActionConfirmation({
  action,
  commitMessage,
  projectName,
  onCancel,
  onConfirm,
}: {
  action: GitAction | undefined;
  commitMessage?: string;
  projectName: string;
  onCancel(): void;
  onConfirm(): void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const copy = action ? ACTION_COPY[action] : undefined;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || !action) return;
    if (!dialog.open) dialog.showModal();
    return () => {
      if (dialog.open) dialog.close();
    };
  }, [action]);

  if (!action || !copy) return null;

  return (
    <dialog aria-labelledby="git-action-title" className="git-action-dialog" onCancel={(event) => { event.preventDefault(); onCancel(); }} ref={dialogRef}>
      <form method="dialog" onSubmit={(event) => { event.preventDefault(); onConfirm(); }}>
        <span className="dialog-kicker">Review before execution</span>
        <h2 id="git-action-title">{copy.title}</h2>
        <p>{copy.description}</p>
        <dl className="git-impact-summary">
          <div><dt>Repository</dt><dd>{projectName}</dd></div>
          <div><dt>Worktree</dt><dd>Active isolated worktree</dd></div>
          <div><dt>Action</dt><dd>{action}</dd></div>
          {action === "commit" ? <div><dt>Message</dt><dd>{commitMessage?.trim() || "Relay changes"}</dd></div> : null}
          {action === "push" ? <div><dt>Remote effect</dt><dd>Configured upstream · non-force</dd></div> : null}
        </dl>
        <p className="git-impact-warning">Relay will re-check the active run state before queuing this action. Remote state is not frozen by this preview.</p>
        <footer>
          <button onClick={onCancel} type="button">Cancel</button>
          <button className="button-primary" type="submit">{copy.confirm}</button>
        </footer>
      </form>
    </dialog>
  );
}
