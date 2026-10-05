import { loadBundledPluginPublicSurfaceModuleSync } from "../../plugin-sdk/facade-runtime.js";
import { resolvePrivateQaBundledPluginsEnv } from "../../plugin-sdk/private-qa-bundled-env.js";
import type { QaRuntimeSurface } from "../../plugin-sdk/qa-runner-runtime.js";

function isMissingQaRuntimeError(error: unknown) {
  if (!(error instanceof Error)) {
    return false;
  }
  return (
    error.message.includes("qa-lab") &&
    (error.message.includes("runtime-api.js") ||
      error.message.startsWith("Unable to open bundled plugin public surface "))
  );
}

/** Load the private QA Lab runtime facade used by QA runner commands. */
export function loadQaRuntimeModule(): QaRuntimeSurface {
  const env = resolvePrivateQaBundledPluginsEnv();
  return loadBundledPluginPublicSurfaceModuleSync<QaRuntimeSurface>({
    dirName: ["qa", "lab"].join("-"),
    artifactBasename: ["runtime-api", "js"].join("."),
    ...(env ? { env } : {}),
  });
}

/** Returns whether the private QA Lab runtime facade is available in this build. */
export function isQaRuntimeAvailable(): boolean {
  try {
    loadQaRuntimeModule();
    return true;
  } catch (error) {
    if (isMissingQaRuntimeError(error)) {
      return false;
    }
    throw error;
  }
}
