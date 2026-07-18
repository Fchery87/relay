import { useEffect, useRef, useState } from "react";
import { EditorState } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
import { unifiedMergeView } from "@codemirror/merge";

import {
  FILE_KIND_LABEL,
  groupCommentsByFile,
  isReviewableDiff,
  splitFiles,
  summarizeFiles,
  type DiffComment,
  type ParsedFile,
} from "./diff-utils";

export function DiffView({ comments, content, onCreateComment }: {
  comments: DiffComment[];
  content: string;
  onCreateComment?(input: { content: string; endLine: number; filePath: string; startLine: number }): Promise<unknown>;
}) {
  const files = splitFiles(content);
  const commentsByFile = groupCommentsByFile(comments);
  const reviewable = Boolean(onCreateComment) && isReviewableDiff(content);
  const createComment = onCreateComment ?? (async () => undefined);

  if (files.length === 0) {
    return (
      <div className="diff-empty" role="status">
        <span aria-hidden="true" className="diff-empty-mark">◇</span>
        <p className="diff-empty-text">{content || "No changes in the working tree."}</p>
      </div>
    );
  }

  const summary = summarizeFiles(files);

  return (
    <div className="diff-files">
      <div className="diff-summary" role="status">
        <span className="diff-summary-count">
          {summary.fileCount} {summary.fileCount === 1 ? "file" : "files"} changed
        </span>
        <span className="diff-summary-bar">
          <span className="diff-stat-add">+{summary.additions}</span>
          <span className="diff-stat-del">−{summary.deletions}</span>
        </span>
      </div>
      {files.map((file) => (
        <DiffFileSection
          key={file.name}
          comments={commentsByFile.get(file.name) ?? []}
          file={file}
          onCreateComment={createComment}
          reviewable={reviewable}
        />
      ))}
    </div>
  );
}

function DiffFileSection({ comments, file, onCreateComment, reviewable }: {
  comments: DiffComment[];
  file: ParsedFile;
  onCreateComment(input: { content: string; endLine: number; filePath: string; startLine: number }): Promise<unknown>;
  reviewable: boolean;
}) {
  const [expanded, setExpanded] = useState(true);
  const unresolvedCount = comments.filter((comment) => !comment.resolved).length;
  const resolvedCount = comments.length - unresolvedCount;

  return (
    <section className="diff-file">
      <button
        aria-expanded={expanded}
        aria-label={`${file.name} — ${file.kind}`}
        className="diff-file-header"
        onClick={() => setExpanded((value) => !value)}
        type="button"
      >
        <span aria-hidden="true" className="diff-file-glyph">{expanded ? "▾" : "▸"}</span>
        <span className="diff-file-path">{file.name}</span>
        <span className="diff-file-kind" data-kind={file.kind} title={file.kind}>{FILE_KIND_LABEL[file.kind]}</span>
        <span className="diff-file-stats">
          {file.additions > 0 ? <span className="diff-stat-add">+{file.additions}</span> : null}
          {file.deletions > 0 ? <span className="diff-stat-del">−{file.deletions}</span> : null}
        </span>
        {comments.length > 0 ? (
          <span className="diff-file-comments" data-has-unresolved={unresolvedCount > 0 || undefined} title={`${unresolvedCount} unresolved, ${resolvedCount} resolved`}>
            {comments.length}
          </span>
        ) : null}
      </button>
      {expanded ? (
        <DiffFile
          comments={comments}
          content={file.content}
          filePath={file.name}
          onCreateComment={onCreateComment}
          reviewable={reviewable}
        />
      ) : null}
    </section>
  );
}

function DiffFile({ comments, content, filePath, onCreateComment, reviewable }: {
  comments: DiffComment[];
  content: string;
  filePath: string;
  onCreateComment(input: { content: string; endLine: number; filePath: string; startLine: number }): Promise<unknown>;
  reviewable: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [comment, setComment] = useState("");
  const [commenting, setCommenting] = useState(false);
  const [range, setRange] = useState({ endLine: 1, startLine: 1 });
  useEffect(() => {
    if (!host.current) return;
    const view = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: content,
        extensions: [
          lineNumbers(),
          EditorState.readOnly.of(true),
          EditorView.lineWrapping,
          unifiedMergeView({ original: "", mergeControls: false }),
          EditorView.updateListener.of((update) => {
            if (!update.selectionSet) return;
            const selection = update.state.selection.main;
            const endPosition = selection.to > selection.from && selection.to === update.state.doc.lineAt(selection.to).from ? selection.to - 1 : selection.to;
            setRange({ endLine: update.state.doc.lineAt(endPosition).number, startLine: update.state.doc.lineAt(selection.from).number });
          }),
        ],
      }),
    });
    return () => view.destroy();
  }, [content]);
  async function submitComment(event: React.FormEvent) {
    event.preventDefault();
    if (!comment.trim()) return;
    await onCreateComment({ content: comment.trim(), filePath, ...range });
    setComment("");
    setCommenting(false);
  }
  return <>
    <div className="diff-editor" ref={host} />
    {reviewable ? <div className="diff-comment-toolbar"><button onClick={() => setCommenting((value) => !value)} type="button">Comment on {range.startLine === range.endLine ? `line ${range.startLine}` : `lines ${range.startLine}-${range.endLine}`}</button></div> : null}
    {reviewable && commenting ? <form className="diff-comment-form" onSubmit={(event) => void submitComment(event)}><textarea aria-label={`Comment on ${filePath} lines ${range.startLine}-${range.endLine}`} onChange={(event) => setComment(event.target.value)} value={comment} /><button disabled={!comment.trim()} type="submit">Add comment</button></form> : null}
    {comments.length > 0 ? <ol className="diff-comments">{comments.map((item) => <li className={item.resolved ? "diff-comment diff-comment-resolved" : "diff-comment"} key={item._id}><span>{item.startLine === item.endLine ? `Line ${item.startLine}` : `Lines ${item.startLine}-${item.endLine}`}</span><p>{item.content}</p><strong>{item.resolved ? "Resolved" : "Pending"}</strong></li>)}</ol> : null}
  </>;
}
