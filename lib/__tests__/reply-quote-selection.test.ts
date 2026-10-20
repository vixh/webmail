import { afterEach, describe, expect, it } from "vitest";
import { getReplyQuoteSelection } from "../reply-quote-selection";

afterEach(() => {
  document.body.replaceChildren();
  document.getSelection()?.removeAllRanges();
});

function select(node: Node, start: number, end: number) {
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, end);
  const selection = document.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
}

describe("getReplyQuoteSelection", () => {
  it("captures text and formatting from inside the message body", () => {
    const root = document.createElement("div");
    root.innerHTML = "before <strong>selected text</strong> after";
    document.body.appendChild(root);
    const range = document.createRange();
    range.selectNode(root.querySelector("strong")!);
    const selection = document.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    expect(getReplyQuoteSelection(root, { includeHtml: true })).toEqual({
      body: "selected text",
      htmlBody: "<strong>selected text</strong>",
    });
  });

  it("returns plain text without an HTML variant for a plain message", () => {
    const root = document.createElement("div");
    root.textContent = "first\nsecond";
    document.body.appendChild(root);
    select(root.firstChild!, 0, root.textContent.length);

    expect(getReplyQuoteSelection(root)).toEqual({ body: "first\nsecond" });
  });

  it("ignores collapsed and out-of-body selections", () => {
    const root = document.createElement("div");
    const outside = document.createElement("div");
    root.textContent = "message";
    outside.textContent = "toolbar";
    document.body.append(root, outside);

    select(outside.firstChild!, 0, outside.textContent.length);
    expect(getReplyQuoteSelection(root, { includeHtml: true })).toBeNull();

    select(root.firstChild!, 2, 2);
    expect(getReplyQuoteSelection(root, { includeHtml: true })).toBeNull();
  });
});
