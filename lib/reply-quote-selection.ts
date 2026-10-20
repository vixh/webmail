export interface ReplyQuoteSelection {
  body: string;
  htmlBody?: string;
}

/**
 * Return the current browser selection only when both ends belong to the
 * rendered message body. This deliberately ignores selections in headers,
 * sidebars, plugins, and other messages in a conversation.
 */
export function getReplyQuoteSelection(
  root: HTMLElement | null,
  options: { includeHtml?: boolean } = {},
): ReplyQuoteSelection | null {
  if (!root) return null;

  const selection = root.ownerDocument.getSelection?.();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;

  const range = selection.getRangeAt(0);
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;

  const body = selection.toString().replace(/\r\n?/g, "\n").trim();
  if (!body) return null;

  if (!options.includeHtml) return { body };

  const container = root.ownerDocument.createElement("div");
  container.appendChild(range.cloneContents());
  const htmlBody = container.innerHTML.trim();

  return htmlBody ? { body, htmlBody } : { body };
}
