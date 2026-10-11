import {
  SOURCE_LOCATION_KEY,
  USER_SOURCE_FILE,
  normalizeSourceStack,
  type SourceLocation,
} from "openclaw/plugin-sdk/code-mode-executor-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { JSException, type QuickJS } from "quickjs-wasi";

export function readSourceLocation(vm: QuickJS): SourceLocation | undefined {
  // Old snapshots have no record. Read data descriptors without invoking guest getters.
  const descriptor = vm.global.getOwnPropertyDescriptor(SOURCE_LOCATION_KEY);
  if (!descriptor) {
    return undefined;
  }
  try {
    if (
      descriptor.writable ||
      descriptor.configurable ||
      descriptor.enumerable ||
      !descriptor.value?.isString
    ) {
      return undefined;
    }
    const value: unknown = JSON.parse(descriptor.value.toString());
    if (!isRecord(value)) {
      return undefined;
    }
    const { file, lineOffset, lineCount, columnOffset, endColumn } = value;
    const isOffset = (offset: unknown): offset is number =>
      typeof offset === "number" && Number.isSafeInteger(offset) && offset >= 0;
    if (
      file !== USER_SOURCE_FILE ||
      !isOffset(lineOffset) ||
      !isOffset(lineCount) ||
      lineCount === 0 ||
      !isOffset(columnOffset) ||
      !isOffset(endColumn) ||
      endColumn === 0 ||
      !Number.isSafeInteger(lineOffset + lineCount) ||
      (lineCount === 1 && endColumn <= columnOffset)
    ) {
      return undefined;
    }
    return {
      file,
      lineOffset,
      lineCount,
      columnOffset,
      endColumn,
    };
  } catch {
    return undefined;
  } finally {
    descriptor.value?.dispose();
    descriptor.get?.dispose();
    descriptor.set?.dispose();
  }
}

// QuickJS error stacks are backtrace frames only ("    at file:line:col"), with
// no leading "Name: message" header like V8. Returning .stack alone therefore
// dropped the actual cause, surfacing failures to the model as a bare location
// (e.g. "at openclaw-code-mode:user.js:2:37"). Lead with name+message so the
// model can self-correct, and keep the frames for location.
export function formatQuickJsError(
  name: string,
  message: string,
  stack: string | undefined,
  location?: SourceLocation,
): string {
  const header = message ? `${name}: ${message}` : name;
  const sourceStack = normalizeSourceStack(stack, location);
  if (!sourceStack || sourceStack.split(/\r?\n/, 1)[0] === header) {
    return header;
  }
  return `${header}\n${sourceStack}`;
}

export function errorMessage(error: unknown, location?: SourceLocation): string {
  if (error instanceof JSException) {
    return formatQuickJsError(error.name, error.message, error.stack, location);
  }
  if (error instanceof Error) {
    return error.message || String(error);
  }
  return String(error);
}
