#!/usr/bin/env node
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  collectModuleReferencesFromSource,
  normalizeRepoPath,
  resolveRepoSpecifier,
} from "./lib/guard-inventory-utils.mjs";
import {
  createMessagingDependencyConfig,
  MESSAGING_SOURCE_ROOTS,
  MESSAGING_TEST_PATH,
  type DependencyPath,
} from "./lib/messaging-dependency-rules.mts";
import { createNativeTypeScriptParser } from "./lib/native-typescript.mts";
import { resolveRepoRoot } from "./lib/repo-root.mjs";
import { createRuntimeImportGraph } from "./lib/runtime-import-closure.mts";
import { listGeneratedExtensionAssetSources } from "./lib/static-extension-assets.mts";
import { collectTypeScriptFilesFromRoots, runAsScript } from "./lib/ts-guard-utils.mts";

type Violation = {
  rule: string;
  file: string;
  line: number;
  specifier: string;
  resolvedPath: string;
};
const sourceExtensions = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

function pathMatcher(condition: DependencyPath) {
  const include = condition.path ? new RegExp(condition.path) : undefined;
  const exclude = condition.pathNot ? new RegExp(condition.pathNot) : undefined;
  return (file: string) => (!include || include.test(file)) && (!exclude || !exclude.test(file));
}

/** Enforce the shared config using the incumbent native parser and module resolver. */
export async function collectMessagingArchitectureViolations(
  repoRoot: string,
): Promise<Violation[]> {
  const root = path.resolve(repoRoot);
  const config = createMessagingDependencyConfig(root);
  const rules = config.forbidden.map((rule) => ({
    name: rule.name,
    skipTypes: rule.to.dependencyTypesNot?.includes("type-only") === true,
    from: pathMatcher(rule.from),
    to: pathMatcher(rule.to),
  }));
  const generated = new Set(listGeneratedExtensionAssetSources({ rootDir: root }));
  const testPath = new RegExp(MESSAGING_TEST_PATH);
  const files = (
    await collectTypeScriptFilesFromRoots(
      MESSAGING_SOURCE_ROOTS.map((directory) => path.join(root, directory)),
      {
        fileExtensions: sourceExtensions,
        includeTests: true,
        skipDirectories: ["dist", "build", "coverage", ".git"],
      },
    )
  )
    .map((file) => normalizeRepoPath(root, file))
    .filter((file) => !testPath.test(file) && !generated.has(file))
    .toSorted();
  using parser = createNativeTypeScriptParser({ cwd: root });
  using graph = createRuntimeImportGraph(root, files, {
    sourceImports: true,
    includeTypeOnlyImports: true,
    includeDynamicImports: true,
    includeCommonJs: true,
    includeImportMetaUrl: true,
  });
  const violations: Violation[] = [];
  const pending = new Set(files);
  // Reached test helpers are production dependencies, not an architecture escape hatch.
  for (const file of pending) {
    const absolute = path.join(root, file);
    const source = parser.parseSourceFile(absolute, readFileSync(absolute, "utf8"));
    const references = collectModuleReferencesFromSource(source);
    const applicableRules = rules.filter((rule) => rule.from(file));
    for (const {
      specifier,
      typeOnly,
      kind,
      resolvedFileName,
      isExternalLibraryImport,
    } of graph.dependencies(file)) {
      const resolvedPath =
        resolvedFileName && !isExternalLibraryImport
          ? normalizeRepoPath(root, resolvedFileName)
          : (resolveRepoSpecifier(root, specifier, absolute) ?? specifier);
      if (
        resolvedFileName &&
        !isExternalLibraryImport &&
        MESSAGING_SOURCE_ROOTS.some((directory) => resolvedPath.startsWith(`${directory}/`)) &&
        sourceExtensions.some((extension) => resolvedPath.endsWith(extension)) &&
        !generated.has(resolvedPath)
      ) {
        pending.add(resolvedPath);
      }
      const index = references.findIndex(
        (reference) => reference.specifier === specifier && reference.kind === kind,
      );
      const line = index < 0 ? 1 : (references.splice(index, 1)[0]?.line ?? 1);
      for (const rule of applicableRules) {
        if (!(typeOnly && rule.skipTypes) && (rule.to(resolvedPath) || rule.to(specifier))) {
          violations.push({ rule: rule.name, file, line, specifier, resolvedPath });
        }
      }
    }
  }
  return violations.toSorted(
    (left, right) =>
      left.file.localeCompare(right.file) ||
      left.line - right.line ||
      left.rule.localeCompare(right.rule),
  );
}

export async function main(args = process.argv.slice(2)) {
  if (args.some((arg) => arg !== "--json")) {
    throw new Error(
      "Usage: node --import ./scripts/tsx.mjs scripts/check-messaging-architecture.mts [--json]",
    );
  }
  const violations = await collectMessagingArchitectureViolations(resolveRepoRoot(import.meta.url));
  if (args.includes("--json")) {
    console.log(JSON.stringify(violations, null, 2));
  } else {
    for (const { rule, file, line, specifier, resolvedPath } of violations) {
      console.error(`${rule} ${file}:${line}: ${specifier} -> ${resolvedPath}`);
    }
    console.log(`Messaging architecture: ${violations.length} violation(s).`);
  }
  process.exitCode = violations.length === 0 ? 0 : 1;
}

runAsScript(import.meta.url, main);
