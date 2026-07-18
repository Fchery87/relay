import type { ChangeEvent, FormEvent } from "react";
import type { ThinkingLevel } from "@relay/shared";

import { AccessPicker, type PermissionProfile } from "./access-picker";
import { ModelPicker } from "./model-picker";
import type { TextAttachment } from "./message-attachments";
import type { ThreadStatus } from "./thread-messages";

export function Composer({
  attachmentError,
  attachments,
  content,
  isPlanRun,
  isSubmitting,
  modelId,
  onAttachFiles,
  onContentChange,
  onModelChange,
  onPermissionChange,
  onRemoveAttachment,
  onSubmit,
  permissionProfile,
  receipt,
  status,
  thinkingLevel,
}: {
  attachmentError: string | undefined;
  attachments: ReadonlyArray<TextAttachment>;
  content: string;
  isPlanRun: boolean;
  isSubmitting: boolean;
  modelId: string;
  onAttachFiles: (event: ChangeEvent<HTMLInputElement>) => Promise<void>;
  onContentChange: (content: string) => void;
  onModelChange: (input: { modelId: string; thinkingLevel: ThinkingLevel }) => Promise<unknown>;
  onPermissionChange: (profile: PermissionProfile) => Promise<unknown>;
  onRemoveAttachment: (index: number) => void;
  onSubmit: (event: FormEvent) => Promise<void>;
  permissionProfile: PermissionProfile;
  receipt: "accepted" | "failed" | undefined;
  status: ThreadStatus;
  thinkingLevel: ThinkingLevel;
}) {
  const running = status === "running";
  const queued = status === "queued";
  const midTurn = running || status === "awaiting-approval" || status === "restoring";
  const sendLabel = isSubmitting ? "Sending…" : running ? "Queue steering" : queued ? "Queued" : "Run";

  return (
    <form className="composer" onSubmit={(event) => void onSubmit(event)}>
      <textarea
        aria-label="Directive"
        onChange={(event) => onContentChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            void onSubmit(event);
          }
        }}
        placeholder={running ? "Steer Relay at the next safe boundary…" : "Tell Relay what to do next…"}
        value={content}
      />
      {attachments.length > 0 ? (
        <ul aria-label="Attached context" className="composer-attachments">
          {attachments.map((attachment, index) => (
            <li key={`${attachment.name}:${index}`}>
              <span>{attachment.name}</span>
              <button aria-label={`Remove ${attachment.name}`} onClick={() => onRemoveAttachment(index)} type="button">Remove</button>
            </li>
          ))}
        </ul>
      ) : null}
      {attachmentError ? <p className="composer-error" role="alert">{attachmentError}</p> : null}
      <p aria-live="polite" className="composer-receipt">
        {receipt === "accepted" ? (running ? "Steering accepted for this run." : "Directive accepted for this run.") : receipt === "failed" ? "Relay could not accept the directive. Try again." : ""}
      </p>
      <footer className="composer-footer">
        <label className="composer-attach">
          <input accept=".css,.go,.html,.js,.json,.jsx,.md,.py,.rs,.sh,.ts,.tsx,.txt,.yaml,.yml,text/*" multiple onChange={(event) => void onAttachFiles(event)} type="file" />
          <span aria-hidden="true">⊕</span> Add context
        </label>
        {isPlanRun ? (
          <span className="composer-plan-pair" title="Plan runs use the configured plan and build models"><span aria-hidden="true">◈</span> Plan pair</span>
        ) : (
          <ModelPicker modelId={modelId} onChange={onModelChange} thinkingLevel={thinkingLevel} />
        )}
        <AccessPicker disabled={midTurn} onChange={onPermissionChange} value={permissionProfile} />
        <button aria-label="Send" className="button-primary composer-send" disabled={queued || isSubmitting} type="submit">
          {sendLabel}
        </button>
      </footer>
    </form>
  );
}
