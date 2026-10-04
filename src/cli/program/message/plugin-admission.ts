import { cloneEnvWithPlatformSemantics } from "../../../config/config-env-vars.js";
import { getRuntimeConfig } from "../../../config/config.js";
import { resolveConfigWidePluginMetadataSnapshotAsync } from "../../../config/io.plugin-metadata.js";
import { captureRuntimeConfigPublicationCurrent } from "../../../config/runtime-snapshot.js";
import { resolveConfiguredChannelPluginIds } from "../../../plugins/channel-plugin-ids.js";
import { buildPluginRuntimeLoadOptions } from "../../../plugins/runtime/load-context.js";
import { resolvePluginRuntimeLoadContext } from "../../../plugins/runtime/load-context.resolve.js";
import { withArtifactPreservingStateReads } from "../../../state/openclaw-state-db-readonly.js";

/** Inspect only configured channel owners without preparing Gateway-owned state. */
export async function acquireMessagePluginRegistry(channelIds?: readonly string[]) {
  const config = getRuntimeConfig();
  const publicationCurrent = captureRuntimeConfigPublicationCurrent(config);
  const assertCurrent = () => {
    if (publicationCurrent && !publicationCurrent()) {
      throw new Error("Message config changed during plugin admission; retry the command.");
    }
  };
  const env = cloneEnvWithPlatformSemantics(process.env);
  return await withArtifactPreservingStateReads(async () => {
    const metadataSnapshot = await resolveConfigWidePluginMetadataSnapshotAsync({ config, env });
    assertCurrent();
    const pluginIds = resolveConfiguredChannelPluginIds({
      config,
      activationSourceConfig: config,
      env,
      channelIds,
      manifestRecords: metadataSnapshot.plugins,
      discovery: metadataSnapshot.discovery,
    });
    if (pluginIds.length === 0) {
      return undefined;
    }
    const context = resolvePluginRuntimeLoadContext({
      config,
      activationSourceConfig: config,
      env,
      metadataSnapshot,
      onlyPluginIds: pluginIds,
    });
    const { acquirePluginRegistryForInspection } = await import("../../../plugins/loader.js");
    assertCurrent();
    const inspection = await acquirePluginRegistryForInspection(
      buildPluginRuntimeLoadOptions(context, {
        onlyPluginIds: pluginIds,
        discovery: metadataSnapshot.discovery,
        runtimeSideEffects: false,
        throwOnLoadError: true,
      }),
    );
    try {
      assertCurrent();
      return { ...inspection, assertCurrent };
    } catch (error) {
      await inspection.release();
      throw error;
    }
  });
}
