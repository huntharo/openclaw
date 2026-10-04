// Thread command registration; admitted action normalization belongs to the shared runner.
import type { Command } from "commander";
import type { MessageCliHelpers } from "./helpers.js";

export function registerMessageThreadCommands(message: Command, helpers: MessageCliHelpers) {
  const thread = message.command("thread").description("Thread actions");

  helpers
    .withMessageBase(
      thread
        .command("create")
        .description("Create a thread")
        .requiredOption("--thread-name <name>", "Thread name"),
      "required",
    )
    .option("--message-id <id>", "Message id (optional)")
    .option("-m, --message <text>", "Initial thread message text")
    .option("--auto-archive-min <n>", "Thread auto-archive minutes")
    .action((opts) => helpers.runMessageAction("thread-create", opts));

  helpers
    .withMessageBase(
      thread
        .command("list")
        .description("List threads")
        .requiredOption("--guild-id <id>", "Guild id"),
    )
    .option("--channel-id <id>", "Channel id")
    .option("--include-archived", "Include archived threads", false)
    .option("--before <id>", "Read/search before id")
    .option("--limit <n>", "Result limit")
    .action((opts) => helpers.runMessageAction("thread-list", opts));

  helpers
    .withMessageBase(
      thread
        .command("reply")
        .description("Reply in a thread")
        .requiredOption("-m, --message <text>", "Message body"),
      "required",
    )
    .option(
      "--media <path-or-url>",
      "Attach media (image/audio/video/document). Accepts local paths or URLs.",
    )
    .option("--reply-to <id>", "Reply-to message id")
    .action((opts) => helpers.runMessageAction("thread-reply", opts));
}
