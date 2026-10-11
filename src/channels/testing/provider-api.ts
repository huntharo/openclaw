import { loadBundledPluginPublicSurfaceModuleSync } from "../../plugin-sdk/facade-runtime.js";
import { resolvePrivateQaBundledPluginsEnv } from "../../plugin-sdk/private-qa-bundled-env.js";

/** Explicit QA driver admission; ordinary Gateway dispatch never calls this loader. */
// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- QA callers retain their provider-owned public test contract.
export function loadQaRunnerChannelApi<T extends object>(pluginId: string): T {
  const env = resolvePrivateQaBundledPluginsEnv();
  return loadBundledPluginPublicSurfaceModuleSync<T>({
    dirName: pluginId,
    artifactBasename: "api.js",
    ...(env ? { env } : {}),
  });
}

/** Load a bundled QA runner plugin test API facade by plugin id. */
// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- Retains the existing caller-supplied test API contract.
export function loadQaRunnerBundledPluginTestApi<T extends object>(pluginId: string): T {
  const env = resolvePrivateQaBundledPluginsEnv();
  return loadBundledPluginPublicSurfaceModuleSync<T>({
    dirName: pluginId,
    artifactBasename: "test-api.js",
    ...(env ? { env } : {}),
  });
}
