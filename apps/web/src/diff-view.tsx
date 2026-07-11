import { useEffect, useRef, useState } from "react";
import { EditorState } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
import { unifiedMergeView } from "@codemirror/merge";

export type DiffComment = { _id: string; content: string; endLine: number; filePath: string; resolved: boolean; startLine: number };

export function groupCommentsByFile(comments: DiffComment[]): Map<string, DiffComment[]> {
  const grouped = new Map<string, DiffComment[]>();
  for (const comment of comments) {
    const fileComments = grouped.get(comment.filePath);
    if (fileComments) fileComments.push(comment);
    else grouped.set(comment.filePath, [comment]);
  }
  return grouped;
}

export function isReviewableDiff(content: string): boolean {
  return /^diff --git /m.test(content);
}

export function DiffView({ comments, content, onCreateComment }: {
  comments: DiffComment[];
  content: string;
  onCreateComment(input: { content: string; endLine: number; filePath: string; startLine: number }): Promise<unknown>;
}) {
  const files = splitFiles(content);
  const commentsByFile = groupCommentsByFile(comments);
  const reviewable = isReviewableDiff(content);
  return <div className="diff-files">{files.map((file) => <section className="diff-file" key={file.name}>
    <h3>{file.name}</h3>
    <DiffFile comments={commentsByFile.get(file.name) ?? []} content={file.content} filePath={file.name} onCreateComment={onCreateComment} reviewable={reviewable} />
  </section>)}</div>;
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

function splitFiles(content: string): Array<{ content: string; name: string }> {
  const starts = [...content.matchAll(/^diff --git /gm)].map((match) => match.index);
  if (starts.length === 0) return [{ content, name: "Working tree" }];
  return starts.map((start, index) => {
    const patch = content.slice(start, starts[index + 1] ?? content.length).trimEnd();
    const name = /^\+\+\+ b\/(.+)$/m.exec(patch)?.[1] ?? /^diff --git a\/.+ b\/(.+)$/m.exec(patch)?.[1] ?? "Changed file";
    return { content: patch, name };
  });
}
