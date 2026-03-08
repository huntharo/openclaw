export const CODEX_BUILT_IN_MIRRORED_COMMANDS = [
  {
    baseName: "model",
    description: "Choose the Codex model and reasoning effort.",
  },
  {
    baseName: "fast",
    description: "Toggle Codex Fast mode.",
  },
  {
    baseName: "permissions",
    description: "Choose what Codex is allowed to do.",
  },
  {
    baseName: "experimental",
    description: "Toggle Codex experimental features.",
  },
  {
    baseName: "skills",
    description: "List or use Codex skills.",
  },
  {
    baseName: "review",
    description: "Run Codex review on the current changes.",
  },
  {
    baseName: "stop",
    description: "Stop the active Codex turn.",
  },
  {
    baseName: "rename",
    description: "Rename the current Codex thread.",
  },
  {
    baseName: "init",
    description: "Create an AGENTS.md file with Codex instructions.",
  },
  {
    baseName: "compact",
    description: "Compact the Codex conversation before context fills up.",
  },
  {
    baseName: "plan",
    description: "Switch Codex into Plan mode.",
  },
  {
    baseName: "diff",
    description: "Show the current git diff in Codex.",
  },
  {
    baseName: "status",
    description: "Show Codex session configuration and usage status.",
  },
  {
    baseName: "mcp",
    description: "List Codex MCP tools.",
  },
] as const;

export function getCodexBuiltInMirroredCommandCount(): number {
  return CODEX_BUILT_IN_MIRRORED_COMMANDS.length;
}
