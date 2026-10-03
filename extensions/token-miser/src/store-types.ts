export type TokenMiserScope = {
  agentId: string;
  sessionId: string;
  sessionKey?: string;
};

export type TokenMiserAuthority = {
  allowPersistence: boolean;
  assertCurrent: () => void;
};

export type TokenMiserTextContent = { type: "text"; text: string };

export type TokenMiserMetadata = {
  version: 1;
  scope: TokenMiserScope;
  runtime: "openclaw" | "codex" | "agentsapi";
  runId?: string;
  turnId?: string;
  toolCallId: string;
  toolName: string;
  originalBytes: number;
  expiresAt: number;
  memberIds?: string[];
};

export type TokenMiserCapture = Omit<
  TokenMiserMetadata,
  "version" | "originalBytes" | "expiresAt"
> & {
  content: TokenMiserTextContent[];
  expiresAt?: number;
};

export type TokenMiserReference = { id: string; originalBytes: number; expiresAt: number };

export type TokenMiserAcceptance = { scope: TokenMiserScope; expiresAt: number };

export type TokenMiserRetrieval = {
  id?: string;
  ids?: string[];
  mode: "full" | "head" | "tail" | "lines" | "search" | "batch" | "group";
  offsetBytes?: number;
  maxBytes?: number;
  startLine?: number;
  endLine?: number;
  limit?: number;
  query?: string;
};

export type TokenMiserFullResult = {
  id: string;
  mode: "full" | "group";
  format: "text-content-json-v1";
  encoding: "base64";
  offsetBytes: number;
  totalBytes: number;
  nextOffsetBytes?: number;
  data: string;
  memberIds?: string[];
};

type TokenMiserLineResult = {
  id: string;
  mode: "head" | "tail" | "lines" | "search";
  totalLines: number;
  lines: Array<{ line: number; text: string }>;
  nextLine?: number;
};

export type TokenMiserRetrievalResult =
  | TokenMiserFullResult
  | TokenMiserLineResult
  | {
      mode: "batch";
      results: TokenMiserFullResult[];
    };
