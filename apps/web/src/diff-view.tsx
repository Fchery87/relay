import { useEffect, useRef } from "react";
import { EditorState } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
import { unifiedMergeView } from "@codemirror/merge";

export function DiffView({ content }: { content: string }) {
  const files = splitFiles(content);
  return <div className="diff-files">{files.map((file) => <section className="diff-file" key={file.name}>
    <h3>{file.name}</h3>
    <DiffFile content={file.content} />
  </section>)}</div>;
}

function DiffFile({ content }: { content: string }) {
  const host = useRef<HTMLDivElement>(null);
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
        ],
      }),
    });
    return () => view.destroy();
  }, [content]);
  return <div className="diff-editor" ref={host} />;
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
