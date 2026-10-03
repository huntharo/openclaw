/* @vitest-environment jsdom */
import { nothing, render } from "lit";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { HumanMention } from "../../lib/chat/chat-types.ts";
import { NewSessionComposerTextareaController } from "../new-session/composer-controller.ts";
import { renderNewSessionComposer } from "../new-session/composer.ts";
import { createComposerProps, resetComposerFixture } from "./chat-composer.test-support.ts";
import type { ComposerReferenceSources } from "./components/chat-composer-reference-menu.ts";
import { renderChatComposer } from "./components/chat-composer.ts";

afterEach(() => resetComposerFixture());

const sources: ComposerReferenceSources = {
  ownerKey: "gateway-one:operator-one",
  sessions: [
    {
      key: "agent:main:review",
      agentId: "main",
      label: "Release [review]",
      href: "/prefix/chat/main/review?session=agent%3Amain%3Areview",
    },
  ],
  pullRequests: [
    { number: 42, title: "Repair composer", url: "https://github.com/example/repo/pull/42" },
  ],
  projects: [{ id: "project-one", label: "Repository", path: '/work/repo with "quotes"' }],
  environments: [{ id: "node:machine-one", label: "Build machine", status: "offline" }],
};

function fixture(
  kind: "chat" | "new-session",
  initial = "",
  initialMentions: readonly HumanMention[] = [],
) {
  const container = document.createElement("div");
  document.body.append(container);
  let draft = initial;
  let mentions = initialMentions;
  let referenceSources: ComposerReferenceSources | undefined = sources;
  const send = vi.fn();
  const props = createComposerProps();
  const controller = new NewSessionComposerTextareaController();
  onTestFinished(() => controller.disconnect());
  const onInput = (next: string, nextMentions?: readonly HumanMention[]) => {
    draft = next;
    mentions = nextMentions ?? mentions;
  };
  const draw = () =>
    render(
      kind === "chat"
        ? renderChatComposer({
            ...props,
            draft,
            mentions,
            referenceSources,
            getDraft: () => draft,
            getMentions: () => mentions,
            onDraftChange: onInput,
            onRequestUpdate: draw,
            onSend: send,
          })
        : renderNewSessionComposer({
            renderCritters: () => nothing,
            message: draft,
            mentions,
            getMentions: () => mentions,
            referenceSources,
            attachments: [],
            getAttachments: () => [],
            canSubmit: true,
            pendingAttachmentReads: 0,
            readSignal: new AbortController().signal,
            requiresModifier: false,
            requestUpdate: draw,
            submitting: false,
            textareaController: controller,
            onAttachmentsChange: () => undefined,
            onPendingReadsChange: () => undefined,
            onInput,
            onSubmit: send,
          }),
      container,
    );
  draw();
  const textarea = container.querySelector<HTMLTextAreaElement>("textarea")!;
  const input = (value: string, data: string, inputType = "insertText") => {
    textarea.value = value;
    textarea.setSelectionRange(value.length, value.length);
    textarea.dispatchEvent(new InputEvent("input", { bubbles: true, inputType, data }));
    draw();
  };
  const key = (pressedKey: string) => {
    const event = new KeyboardEvent("keydown", {
      key: pressedKey,
      bubbles: true,
      cancelable: true,
    });
    textarea.dispatchEvent(event);
    draw();
    return event;
  };
  return {
    container,
    textarea,
    input,
    key,
    send,
    value: () => ({ draft, mentions }),
    catalog: (next: ComposerReferenceSources | undefined) => {
      referenceSources = next;
      draw();
    },
  };
}

describe.each(["chat", "new-session"] as const)("%s composer catalog references", (kind) => {
  it("inserts distinct session and PR links without sending or losing human recipients", async () => {
    const view = fixture(kind, "@Alex ", [{ profileId: "alex", start: 0, end: 5 }]);
    view.input("@Alex #", "#");
    const options = view.container.querySelectorAll('[role="option"]');
    expect(options).toHaveLength(2);
    expect(options[0]?.textContent).toContain("#42");
    expect(options[1]?.textContent).toContain("Release [review]");
    view.key("End");
    expect(view.textarea.getAttribute("aria-activedescendant")).toBe(options[1]?.id);
    expect(view.key("Tab").defaultPrevented).toBe(true);
    await Promise.resolve();
    expect(view.value()).toEqual({
      draft:
        '@Alex [#Release \\[review\\]](</prefix/chat/main/review?session=agent%3Amain%3Areview>) (session "agent:main:review", agent "main") ',
      mentions: [{ profileId: "alex", start: 0, end: 5 }],
    });
    view.input(`${view.value().draft}#`, "#");
    view.key("Enter");
    expect(view.value().draft).toContain("[#42](<https://github.com/example/repo/pull/42>)");
    expect(view.send).not.toHaveBeenCalled();
  });

  it("uses exact directory and environment identities while displaying offline status", () => {
    const view = fixture(kind);
    view.input("@", "@");
    expect(view.container.querySelector('[role="listbox"]')).toBeNull();
    view.input("@/", "/");
    expect(view.container.querySelector('[role="option"]')?.textContent).toContain(
      '/work/repo with "quotes"',
    );
    view.key("Enter");
    expect(view.value().draft).toBe(
      'Project "project-one" (directory "/work/repo with \\"quotes\\"") ',
    );
    view.input("@:machine", "@:machine");
    // Opening requires typing the trigger, then extending its query.
    view.input("@:", ":");
    view.input("@:machine", "machine");
    expect(view.container.querySelector('[role="option"]')?.textContent).toContain("offline");
    view.key("Tab");
    expect(view.value().draft).toBe('Environment "node:machine-one" ("Build machine") ');
    expect(view.send).not.toHaveBeenCalled();
  });

  it("retires replaced-owner catalogs and removed options before activation", () => {
    const view = fixture(kind);
    view.input("#", "#");
    const retiredOption = view.container.querySelector<HTMLElement>('[role="option"]')!;
    view.catalog({ ...sources, pullRequests: [], sessions: [] });
    retiredOption.click();
    expect(view.value().draft).toBe("#");
    view.catalog({ ...sources, ownerKey: "gateway-two:operator-one" });
    expect(view.container.querySelector('[role="listbox"]')).toBeNull();
    view.catalog(undefined);
    view.input("@/", "/");
    expect(view.container.querySelector('[role="listbox"]')).toBeNull();
  });

  it.each([
    ["inline code", "`#", "insertText"],
    ["fenced code", "```text\n#", "insertText"],
    ["quoted example", "> #", "insertText"],
    ["URL fragment", "https://example.test/#", "insertText"],
    ["slash argument", "/help #", "insertText"],
    ["pasted reference", "#", "insertFromPaste"],
  ])("keeps %s as prose", (_name, value, inputType) => {
    const view = fixture(kind);
    view.input(value, "#", inputType);
    expect(view.container.querySelector('[role="listbox"]')).toBeNull();
    expect(view.value().draft).toBe(value);
  });

  it("bounds suggestions and leaves empty catalogs keyboard-accessible", () => {
    const view = fixture(kind);
    view.catalog({
      ownerKey: sources.ownerKey,
      sessions: Array.from({ length: 100 }, (_, index) => ({
        key: `session-${index}`,
        label: `Session ${index}`,
        href: `/chat/session-${index}`,
      })),
    });
    view.input("#", "#");
    expect(view.container.querySelectorAll('[role="option"]')).toHaveLength(30);
    view.input("#missing", "missing");
    expect(view.container.querySelector('[role="status"]')?.textContent).toContain(
      "No matching references",
    );
    expect(view.key("Tab").defaultPrevented).toBe(false);
    expect(view.key("Escape").defaultPrevented).toBe(true);
    expect(view.container.querySelector('[role="listbox"]')).toBeNull();
  });
});
