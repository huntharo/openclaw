export function commandResult(stdout = "", code = 0) {
  return {
    code,
    signal: null,
    killed: false,
    stdout: Buffer.from(stdout),
    stderr: Buffer.alloc(0),
  };
}

/** Add CLI response framing while retaining each publication fixture's command behavior. */
export function createPublicationCommandMock(
  runCommand: typeof import("../process/exec.js").runCommandBuffered,
) {
  return async (
    argv: string[],
    options: Parameters<typeof import("../process/exec.js").runCommandBuffered>[1],
  ) => {
    const result = await runCommand(
      argv.filter((arg) => arg !== "--include"),
      options,
    );
    return argv[0] === "gh" &&
      argv[1] === "api" &&
      argv.includes("--include") &&
      !result.stdout.toString("utf8").startsWith("HTTP/")
      ? {
          ...result,
          stdout: Buffer.concat([
            Buffer.from(`HTTP/2.0 ${result.code === 0 ? 200 : 500}\r\n\r\n`),
            result.stdout,
          ]),
        }
      : result;
  };
}
