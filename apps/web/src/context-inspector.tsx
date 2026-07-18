import { useEffect, useRef } from "react";
import type { ReactNode } from "react";

export function ContextInspector({
  open,
  title,
  children,
  onClose,
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  onClose(): void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const restoreTargetRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open) {
      restoreTargetRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      if (!dialog.open) dialog.showModal();
      return;
    }
    if (dialog.open) dialog.close();
    restoreTargetRef.current?.focus();
    restoreTargetRef.current = null;
  }, [open]);

  if (!open) return null;

  return (
    <dialog aria-labelledby="context-inspector-title" className="context-inspector-dialog" onCancel={(event) => { event.preventDefault(); onClose(); }} ref={dialogRef}>
      <header className="inspector-heading">
        <div><span>Inspector</span><strong id="context-inspector-title">{title}</strong></div>
        <button autoFocus aria-label="Close inspector" onClick={onClose} type="button">Close</button>
      </header>
      {children}
    </dialog>
  );
}
