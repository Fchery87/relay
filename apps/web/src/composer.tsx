import { useEffect, useRef, useState } from "react";
import type { ChangeEvent, FormEvent, KeyboardEvent } from "react";
import type { ThinkingLevel } from "@relay/shared";

import { AccessPicker, type PermissionProfile } from "./access-picker";
import { ModelPicker } from "./model-picker";
import { ReasoningVariantPicker } from "./reasoning-variant-picker";
import type { TextAttachment } from "./message-attachments";
import type { ThreadStatus } from "./thread-messages";

export type SlashCommandEntry = {
  argumentHint?: string;
  description: string;
  name: string;
  scope: "builtin" | "project" | "skill" | "user";
};

const SLASH_QUERY_PATTERN = /^\/([a-z0-9:_-]*)$/i;

export function Composer({
  attachmentError,
  attachments,
  commands = [],
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
  commands?: ReadonlyArray<SlashCommandEntry>;
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

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [highlightIndex, setHighlightIndex] = useState(0);
  const [dismissedContent, setDismissedContent] = useState<string | null>(null);

  const slashQuery = SLASH_QUERY_PATTERN.exec(content)?.[1] ?? null;
  const filteredCommands = slashQuery !== null
    ? commands.filter((command) => command.name.toLowerCase().startsWith(slashQuery.toLowerCase()))
    : [];
  const menuOpen = slashQuery !== null && filteredCommands.length > 0 && dismissedContent !== content;
  const clampedIndex = Math.min(highlightIndex, filteredCommands.length - 1);

  useEffect(() => {
    setHighlightIndex(0);
  }, [slashQuery]);

  function selectCommand(command: SlashCommandEntry) {
    onContentChange(`/${command.name} `);
    setDismissedContent(null);
    textareaRef.current?.focus();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (menuOpen) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setHighlightIndex((current) => (current + 1) % filteredCommands.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setHighlightIndex((current) => (current - 1 + filteredCommands.length) % filteredCommands.length);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        selectCommand(filteredCommands[clampedIndex]!);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setDismissedContent(content);
        return;
      }
    }
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void onSubmit(event);
    }
  }

  return (
    <form className="composer" onSubmit={(event) => void onSubmit(event)}>
      <div className="composer-input">
        <textarea
          aria-label="Directive"
          onChange={(event) => onContentChange(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={running ? "Steer Relay at the next safe boundary…" : "Tell Relay what to do next…"}
          ref={textareaRef}
          value={content}
        />
        {menuOpen ? (
          <div className="composer-command-menu" role="listbox" aria-label="Slash commands">
            {filteredCommands.map((command, index) => (
              <button
                aria-selected={index === clampedIndex}
                className="composer-command-option"
                key={command.name}
                onClick={() => selectCommand(command)}
                role="option"
                type="button"
              >
                <strong>/{command.name}{command.argumentHint ? ` ${command.argumentHint}` : ""}</strong>
                <small>{command.description}</small>
              </button>
            ))}
          </div>
        ) : null}
      </div>
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
          <>
            <ModelPicker disabled={midTurn} modelId={modelId} onChange={onModelChange} thinkingLevel={thinkingLevel} />
            <ReasoningVariantPicker disabled={midTurn} modelId={modelId} onChange={(thinkingLevel) => onModelChange({ modelId, thinkingLevel })} thinkingLevel={thinkingLevel} />
          </>
        )}
        <AccessPicker disabled={midTurn} onChange={onPermissionChange} value={permissionProfile} />
        <button aria-label="Send" className="button-primary composer-send" disabled={queued || isSubmitting} type="submit">
          {sendLabel}
        </button>
      </footer>
    </form>
  );
}
