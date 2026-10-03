import { html, nothing } from "lit";
import {
  handleComposerMenuKeydown,
  renderComposerMenu,
  renderComposerMenuOption,
} from "../../../components/composer-menu.ts";
import { t } from "../../../i18n/index.ts";
import { updateHumanMentions } from "../../../lib/chat/human-mentions.ts";
import { paneDomId } from "./chat-composer-dom.ts";
import type { HumanMentionMenuHost } from "./chat-composer-mention-menu.ts";

/** The host supplies accessible facts from its existing catalogs, never a new discovery read. */
export type ComposerReferenceSources = {
  ownerKey: string;
  sessions?: readonly { key: string; agentId?: string; label: string; href: string }[];
  pullRequests?: readonly { number: number; title: string; url: string }[];
  projects?: readonly { id: string; label: string; path?: string }[];
  environments?: readonly { id: string; label: string; status: string }[];
};

type ReferenceKind = "hash" | "project" | "environment";
type ReferenceTarget = {
  kind: ReferenceKind;
  start: number;
  end: number;
  query: string;
  value: string;
};
type ReferenceOption = { id: string; label: string; detail: string; text: string };
const MAX_REFERENCE_OPTIONS = 30;

function findTarget(value: string, caret: number): ReferenceTarget | null {
  if (value.trimStart().startsWith("/")) {
    return null;
  }
  const before = value.slice(0, caret);
  const line = before.slice(before.lastIndexOf("\n") + 1);
  if (
    /^\s*>/u.test(line) ||
    (before.match(/```/gu)?.length ?? 0) % 2 !== 0 ||
    (line.match(/`/gu)?.length ?? 0) % 2 !== 0
  ) {
    return null;
  }
  const match = /(?:^|[\s([{])(#|@\/|@:)([^\s[\]`]{0,128})$/u.exec(before);
  if (!match) {
    return null;
  }
  const trigger = match[1]!;
  const query = match[2]!;
  let end = caret;
  while (end < value.length && /[^\s[\]`]/u.test(value[end]!)) {
    end += 1;
  }
  return {
    kind: trigger === "#" ? "hash" : trigger === "@/" ? "project" : "environment",
    start: caret - query.length - trigger.length,
    end,
    query,
    value,
  };
}

function link(label: string, href: string): string {
  return `[${label.replace(/[\\[\]`]/gu, "\\$&").replace(/\s+/gu, " ")}](<${href.replace(/[<>\s]/gu, (character) => encodeURIComponent(character))}>)`;
}

/** Local invocation state only; selected references remain ordinary durable draft text. */
export class ComposerReferenceMenu {
  private sources?: ComposerReferenceSources;
  private target: ReferenceTarget | null = null;
  private options: ReferenceOption[] = [];
  private index = 0;

  get open() {
    return this.target !== null;
  }

  hint(): string {
    return [
      this.sources?.sessions || this.sources?.pullRequests ? t("chat.references.hashHint") : "",
      this.sources?.projects ? t("chat.references.projectHint") : "",
      this.sources?.environments ? t("chat.references.environmentHint") : "",
    ]
      .filter(Boolean)
      .join(" · ");
  }

  syncSources(sources: ComposerReferenceSources | undefined) {
    if (sources === this.sources) {
      return;
    }
    if (sources?.ownerKey !== this.sources?.ownerKey) {
      this.close();
    }
    this.sources = sources;
    if (this.target) {
      this.filterOptions();
    }
  }

  close() {
    this.target = null;
    this.options = [];
    this.index = 0;
  }

  update(
    input: Pick<HTMLTextAreaElement, "value" | "selectionStart" | "selectionEnd">,
    requestUpdate: () => void,
    intent: "input" | "trigger" | "selection" = "selection",
  ) {
    let target =
      this.sources && input.selectionStart === input.selectionEnd
        ? findTarget(input.value, input.selectionStart)
        : null;
    if (
      target &&
      !(target.kind === "hash"
        ? this.sources?.sessions || this.sources?.pullRequests
        : target.kind === "project"
          ? this.sources?.projects
          : this.sources?.environments)
    ) {
      target = null;
    }
    if (
      !target ||
      (!this.open && intent !== "trigger") ||
      (intent === "selection" &&
        (target.start !== this.target?.start || input.value !== this.target.value))
    ) {
      if (this.open) {
        this.close();
        requestUpdate();
      }
      return;
    }
    if (target.start === this.target?.start && target.query === this.target.query) {
      return;
    }
    this.target = target;
    this.index = 0;
    this.filterOptions();
    requestUpdate();
  }

  private filterOptions() {
    const sources = this.sources;
    const target = this.target;
    if (!sources || !target) {
      return;
    }
    const selected = this.options[this.index]?.id;
    const options: ReferenceOption[] = [];
    const query = target.query.toLocaleLowerCase();
    const add = (option: ReferenceOption) => {
      if (
        options.length < MAX_REFERENCE_OPTIONS &&
        `${option.label} ${option.detail}`.toLocaleLowerCase().includes(query) &&
        !options.some((existing) => existing.id === option.id)
      ) {
        options.push(option);
      }
    };
    if (target.kind === "hash") {
      for (const pr of sources.pullRequests ?? []) {
        add({
          id: pr.url,
          label: `#${pr.number}`,
          detail: `${pr.title} · ${pr.url}`,
          text: link(`#${pr.number}`, pr.url),
        });
      }
      for (const session of sources.sessions ?? []) {
        add({
          id: session.href,
          label: session.label,
          detail: `${t("chat.references.session")} · ${session.agentId ?? ""} · ${session.key}`,
          text: `${link(`#${session.label}`, session.href)} (session ${JSON.stringify(session.key)}${session.agentId ? `, agent ${JSON.stringify(session.agentId)}` : ""})`,
        });
      }
    } else if (target.kind === "project") {
      for (const project of sources.projects ?? []) {
        add({
          id: project.id,
          label: project.label,
          detail: project.path ?? project.id,
          text: `Project ${JSON.stringify(project.id)}${project.path ? ` (directory ${JSON.stringify(project.path)})` : ""}`,
        });
      }
    } else {
      for (const environment of sources.environments ?? []) {
        add({
          id: environment.id,
          label: environment.label,
          detail: `${environment.id} · ${environment.status}`,
          text: `Environment ${JSON.stringify(environment.id)} (${JSON.stringify(environment.label)})`,
        });
      }
    }
    this.options = options;
    this.index = Math.max(
      0,
      options.findIndex((option) => option.id === selected),
    );
  }

  activeId(paneId: string) {
    return this.options[this.index] ? paneDomId(paneId, `reference-option-${this.index}`) : null;
  }

  activeLabel() {
    return this.options[this.index]?.label ?? "";
  }

  handleKeydown(event: KeyboardEvent, host: HumanMentionMenuHost, requestUpdate: () => void) {
    if (!this.open || event.defaultPrevented || event.isComposing || event.keyCode === 229) {
      return false;
    }
    return handleComposerMenuKeydown(event, {
      count: this.options.length,
      index: this.index,
      consumeEmpty: false,
      close: () => {
        this.close();
        requestUpdate();
      },
      move: (index) => {
        this.index = index;
        requestUpdate();
        return this.activeId(host.paneId);
      },
      select: () => this.select(this.options[this.index]!, host, requestUpdate),
    });
  }

  private select(option: ReferenceOption, host: HumanMentionMenuHost, requestUpdate: () => void) {
    const textarea = host.getTextarea();
    if (!textarea || textarea.disabled || textarea.readOnly) {
      return;
    }
    this.update(textarea, requestUpdate);
    const target = this.target;
    // A catalog refresh may retire this row between rendering and activation.
    if (
      !target ||
      !this.options.some((current) => current.id === option.id && current.text === option.text)
    ) {
      return;
    }
    const replacement = `${option.text} `;
    const current = textarea.value;
    const next = `${current.slice(0, target.start)}${replacement}${current.slice(target.end)}`;
    host.commitDraft(
      next,
      updateHumanMentions(current, next, host.getMentions(), {
        value: current,
        start: target.start,
        end: target.end,
        inputType: "insertReplacementText",
      }),
    );
    this.close();
    requestUpdate();
    queueMicrotask(() => {
      const input = host.getTextarea();
      input?.focus({ preventScroll: true });
      input?.setSelectionRange(
        target.start + replacement.length,
        target.start + replacement.length,
      );
    });
  }

  render(host: HumanMentionMenuHost, requestUpdate: () => void) {
    if (!this.target) {
      return nothing;
    }
    const label = t(`chat.references.${this.target.kind}`);
    return renderComposerMenu({
      id: paneDomId(host.paneId, "reference-menu-listbox"),
      label,
      activeId: this.activeId(host.paneId),
      content: html`<div class="slash-menu-group">
        <div class="slash-menu-group__label" role="status">
          ${this.options.length ? label : t("chat.references.empty")}
        </div>
        ${this.options.map((option, index) =>
          renderComposerMenuOption({
            id: paneDomId(host.paneId, `reference-option-${index}`),
            active: this.index === index,
            select: () => this.select(option, host, requestUpdate),
            hover: () => {
              this.index = index;
              requestUpdate();
            },
            icon: this.target?.kind === "hash" ? "#" : "@",
            name: option.label,
            description: option.detail,
          }),
        )}
      </div>`,
    });
  }
}
