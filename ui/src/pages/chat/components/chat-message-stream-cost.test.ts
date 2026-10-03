/* @vitest-environment jsdom */

import { nothing, render } from "lit";
import { guard } from "lit/directives/guard.js";
import { expect, it, vi } from "vitest";
import { renderMessageMarkdown } from "./chat-message-text.ts";

vi.mock("lit/directives/guard.js", { spy: true });

it("bounds memo directive allocations while extending a tail after completed paragraphs", () => {
  const container = document.createElement("div");
  let source = "";
  const draw = () =>
    render(
      renderMessageMarkdown(source, "stream-cost", { role: "assistant", isStreaming: true }, {}),
      container,
    );
  try {
    // Complete each paragraph in a separate render, as independently received
    // chunks do. One initial render would create just one prefix fragment.
    for (let index = 0; index < 64; index++) {
      source += `Paragraph ${index}.\n\n`;
      draw();
    }
    source += "Live tail";
    draw();
    const firstParagraph = container.querySelector("p");
    vi.mocked(guard).mockClear();
    for (let index = 0; index < 16; index++) {
      source += ` chunk-${index}`;
      draw();
    }
    // Factory calls allocate both a directive result and its dependency array.
    // Tail updates may memoize their changed content, but must not allocate one
    // new memo directive per previously completed paragraph on every chunk.
    expect(vi.mocked(guard).mock.calls.length).toBeLessThanOrEqual(32);
    expect(container.querySelector("p")).toBe(firstParagraph);
    expect(container.textContent).toContain("chunk-15");
  } finally {
    render(nothing, container);
  }
});
