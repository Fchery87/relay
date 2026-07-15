export type TextAttachment = {
  content: string;
  name: string;
};

export const MAX_ATTACHMENT_BYTES = 128 * 1024;
export const MAX_ATTACHMENTS = 3;

export function formatOutgoingMessage(content: string, attachments: ReadonlyArray<TextAttachment>): string {
  return [
    content.trim(),
    ...attachments.map((attachment) => {
      const safeName = attachment.name.replace(/[\r\n]/g, " ");
      return `<attachment name="${safeName}">\n${attachment.content}\n</attachment>`;
    }),
  ].filter(Boolean).join("\n\n");
}
