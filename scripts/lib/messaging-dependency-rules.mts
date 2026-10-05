import { collectPluginSourceEntries } from "./plugin-inventory.mts";

export type DependencyPath = { path?: string; pathNot?: string; dependencyTypesNot?: string[] };
export type MessagingDependencyRule = {
  name: string;
  severity: "error";
  comment: string;
  from: DependencyPath;
  to: DependencyPath;
};

const escapePattern = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const alternatives = (values: string[]) => `(?:${values.map(escapePattern).join("|")})`;

// Test roots are excluded as entrypoints, not as dependencies of production code.
export const MESSAGING_TEST_PATH =
  "(?:^|/)(?:__tests__|test|tests|fixtures|test-fixtures|test-support|test-utils|e2e)(?:/|$)|(?:[.-](?:test|spec|fixture|test-support|test-helpers|test-harness|test-utils|test-fixtures|test-compat|e2e-harness))[.][cm]?[jt]sx?$";
export const MESSAGING_SOURCE_ROOTS = ["src", "ui", "apps", "extensions", "packages"];

/** Discover every messaging plugin, including source-only and private QA plugins. */
export function collectMessagingProviders(repoRoot: string) {
  return collectPluginSourceEntries(repoRoot)
    .filter(
      ({ manifest, packageJson }) =>
        (manifest.channels?.length ?? 0) > 0 ||
        manifest.categories?.includes("channels") ||
        packageJson.openclaw?.channel !== undefined,
    )
    .map(({ dirName, id, packageJson }) => ({
      id,
      root: `extensions/${dirName}`,
      packageName: packageJson.name,
    }));
}

/** The messaging subset of dependency-cruiser's direct dependency rules. */
export function createMessagingDependencyConfig(repoRoot: string) {
  const providers = collectMessagingProviders(repoRoot);
  if (providers.length === 0) {
    throw new Error("Messaging architecture check found no channel plugin metadata");
  }
  const providerRoots = providers.map(({ root }) => root);
  const providerPackages = providers.flatMap(({ packageName }) =>
    packageName ? [packageName] : [],
  );
  // Match package specifiers too: an uninstalled provider must not evade enforcement.
  const facadePattern = (ids: string[]) =>
    `^(?:src/plugin-sdk/${alternatives(ids)}[.][cm]?[jt]sx?$|(?:@?openclaw)/plugin-sdk/${alternatives(ids)}(?:[.][cm]?[jt]sx?)?$)`;
  const providerPattern = `^${alternatives([...providerRoots, ...providerPackages])}(?:/|$)|${facadePattern(providers.map(({ id }) => id))}`;
  const providerSourcePattern = `^${alternatives(providerRoots)}/`;
  const hostPattern = "^(?:ui/|apps/|src/(?:gateway|cli|commands|tui|agents)/)";
  const contractPattern =
    "^src/(?:channels/(?:contracts/|message/bus-contract[.][cm]?tsx?$|(?:.*/)?(?:types(?:[.][^/]+)?|[^/]+[.-]types)[.][cm]?tsx?$)|plugin-sdk/channel-contract[.][cm]?tsx?$)";
  const forbidden: MessagingDependencyRule[] = [
    {
      name: "messaging-interface-has-no-provider-or-host-dependencies",
      severity: "error",
      comment: "Generic channel contracts cannot depend on messaging providers or host apps.",
      from: { path: contractPattern },
      to: { path: `${providerPattern}|${hostPattern}` },
    },
    {
      name: "messaging-providers-do-not-import-hosts",
      severity: "error",
      comment: "Messaging plugins use the Plugin SDK, never UI, Gateway, or core internals.",
      from: { path: providerSourcePattern },
      to: { path: "^(?:ui/|apps/|src/(?!plugin-sdk/))" },
    },
    {
      name: "messaging-providers-use-channel-runtime-contracts",
      severity: "error",
      comment:
        "Providers use narrow channel SDK contracts instead of the Gateway convenience barrel.",
      from: { path: providerSourcePattern },
      to: { path: "^(?:src/plugin-sdk/gateway-runtime[.]ts|openclaw/plugin-sdk/gateway-runtime)$" },
    },
    {
      name: "only-messaging-loads-providers",
      severity: "error",
      comment: "Only src/channels owns provider dependencies; hosts consume generic channel APIs.",
      from: { pathNot: `^(?:src/|ui/|apps/)|${providerSourcePattern}` },
      to: { path: providerPattern, dependencyTypesNot: ["type-only"] },
    },
    {
      name: "hosts-do-not-import-messaging-providers",
      severity: "error",
      comment: "Host and SDK source cannot depend on provider implementations, including types.",
      from: { path: "^(?:ui/|apps/|src/(?!channels/))" },
      to: { path: providerPattern },
    },
    ...providers.map(({ id, root, packageName }): MessagingDependencyRule => ({
      name: `messaging-provider-${id}-does-not-import-siblings`,
      severity: "error",
      comment: "Each messaging plugin owns its implementation and cannot import another provider.",
      from: { path: `^${escapePattern(root)}/` },
      to: {
        path: providerPattern,
        pathNot: `^${alternatives([root, ...(packageName ? [packageName] : [])])}(?:/|$)|${facadePattern([id])}`,
      },
    })),
  ];
  return {
    forbidden,
    options: {
      doNotFollow: { path: "node_modules" },
      tsConfig: { fileName: "tsconfig.json" },
      tsPreCompilationDeps: true,
    },
  };
}
