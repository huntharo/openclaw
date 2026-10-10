/* @vitest-environment jsdom */

import { nothing, render } from "lit";
import { expect, it, vi } from "vitest";
import { renderMessageMarkdown } from "./chat-message-text.ts";

it.each([0, 16, 64])("bounds DOM sibling visits after %i completed paragraphs", (completed) => {
  const container = document.createElement("div");
  let source = "";
  const draw = () =>
    render(
      renderMessageMarkdown(
        source,
        `stream-cost-${completed}`,
        { role: "assistant", isStreaming: true },
        {},
      ),
      container,
    );
  try {
    // Each received paragraph creates a separate retained prefix fragment.
    for (let index = 0; index < completed; index++) {
      source += `Paragraph ${index}.\n\n`;
      draw();
    }
    source += "Live tail";
    draw();
    const firstParagraph = container.querySelector("p");
    const text = container.querySelector(".chat-text");
    const nextSibling = Object.getOwnPropertyDescriptor(Node.prototype, "nextSibling")!;
    let visits = 0;
    const readSibling = vi.spyOn(Node.prototype, "nextSibling", "get");
    readSibling.mockImplementation(function (this: Node) {
      if (this.parentNode === text) {
        visits += 1;
      }
      return nextSibling.get!.call(this);
    });
    for (let index = 0; index < 16; index++) {
      source += ` chunk-${index}`;
      draw();
    }
    // The live tail may traverse its own DOM range, but completed paragraphs
    // must not add another traversal on every received chunk.
    expect(visits).toBeLessThanOrEqual(128);
    expect(container.querySelector("p")).toBe(firstParagraph);
    expect(container.textContent).toContain("chunk-15");
  } finally {
    vi.restoreAllMocks();
    render(nothing, container);
  }
});
