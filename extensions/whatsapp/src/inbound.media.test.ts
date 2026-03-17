import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { normalizeMessageContent, downloadMediaMessage } = vi.hoisted(() => ({
  normalizeMessageContent: vi.fn((message: unknown) => message),
  downloadMediaMessage: vi.fn(),
}));

const saveMediaBufferSpy = vi.hoisted(() => vi.fn());

vi.mock("@whiskeysockets/baileys", () => ({
  normalizeMessageContent,
  downloadMediaMessage,
}));

vi.mock("openclaw/plugin-sdk/runtime-env", () => ({
  logVerbose: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/channel-runtime", () => ({
  formatLocationText: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/text-runtime", () => ({
  jidToE164: (jid: string) => {
    const digits = jid.replace(/@.*$/, "");
    return digits ? `+${digits}` : null;
  },
}));

const HOME = path.join(os.tmpdir(), `openclaw-inbound-media-${crypto.randomUUID()}`);
process.env.HOME = HOME;

let downloadInboundMedia: typeof import("./inbound/media.js").downloadInboundMedia;
let extractMentionedJids: typeof import("./inbound/extract.js").extractMentionedJids;

const mockSock = {
  updateMediaMessage: vi.fn(),
  logger: { child: () => ({}) },
} as never;

async function saveMediaBufferMock(
  buffer: Buffer,
  contentType?: string,
  _kind?: string,
  maxBytes?: number,
  fileName?: string,
) {
  saveMediaBufferSpy(buffer, contentType, _kind, maxBytes, fileName);
  const ext =
    fileName && path.extname(fileName)
      ? path.extname(fileName)
      : contentType === "image/jpeg"
        ? ".jpg"
        : contentType === "image/png"
          ? ".png"
          : contentType === "application/pdf"
            ? ".pdf"
            : "";
  const savedPath = path.join(HOME, `saved-${crypto.randomUUID()}${ext}`);
  await fs.mkdir(path.dirname(savedPath), { recursive: true });
  await fs.writeFile(savedPath, buffer);
  return {
    id: `mid-${crypto.randomUUID()}`,
    path: savedPath,
    size: buffer.length,
    contentType,
  };
}

const jpegBuffer = Buffer.from([
  0xff, 0xd8, 0xff, 0xdb, 0x00, 0x43, 0x00, 0x03, 0x02, 0x02, 0x02, 0x02, 0x02, 0x03, 0x02, 0x02,
  0x02, 0x03, 0x03, 0x03, 0x03, 0x04, 0x06, 0x04, 0x04, 0x04, 0x04, 0x04, 0x08, 0x06, 0x06, 0x05,
  0x06, 0x09, 0x08, 0x0a, 0x0a, 0x09, 0x08, 0x09, 0x09, 0x0a, 0x0c, 0x0f, 0x0c, 0x0a, 0x0b, 0x0e,
  0x0b, 0x09, 0x09, 0x0d, 0x11, 0x0d, 0x0e, 0x0f, 0x10, 0x10, 0x11, 0x10, 0x0a, 0x0c, 0x12, 0x13,
  0x12, 0x10, 0x13, 0x0f, 0x10, 0x10, 0x10, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x01, 0x00, 0x01,
  0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, 0xff, 0xc4, 0x00, 0x14, 0x00, 0x01,
  0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff,
  0xc4, 0x00, 0x14, 0x10, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0xff, 0xda, 0x00, 0x0c, 0x03, 0x01, 0x00, 0x02, 0x11, 0x03, 0x11, 0x00, 0x3f, 0x00,
  0xff, 0xd9,
]);

async function saveInboundMedia(params: { message: Record<string, unknown>; mediaMaxMb?: number }) {
  const inboundMedia = await downloadInboundMedia({ message: params.message } as never, mockSock);
  expect(inboundMedia).toBeDefined();
  const maxBytes = (params.mediaMaxMb ?? 50) * 1024 * 1024;
  return await saveMediaBufferMock(
    inboundMedia!.buffer,
    inboundMedia!.mimetype,
    "inbound",
    maxBytes,
    inboundMedia!.fileName,
  );
}

describe("web inbound media saves with extension", () => {
  beforeAll(async () => {
    await fs.rm(HOME, { recursive: true, force: true });
  });

  beforeEach(async () => {
    vi.resetModules();
    saveMediaBufferSpy.mockClear();
    normalizeMessageContent.mockImplementation((message: unknown) => message);
    downloadMediaMessage.mockReset().mockResolvedValue(jpegBuffer);
    ({ downloadInboundMedia } = await import("./inbound/media.js"));
    ({ extractMentionedJids } = await import("./inbound/extract.js"));
  });

  it("stores image extension, extracts caption mentions, and keeps document filename", async () => {
    const savedImage = await saveInboundMedia({
      message: { imageMessage: { mimetype: "image/jpeg" } },
    });

    expect(path.extname(savedImage.path)).toBe(".jpg");
    const stat = await fs.stat(savedImage.path);
    expect(stat.size).toBeGreaterThan(0);

    expect(
      extractMentionedJids({
        imageMessage: {
          caption: "@bot",
          contextInfo: { mentionedJid: ["999@s.whatsapp.net"] },
          mimetype: "image/jpeg",
        },
      } as never),
    ).toEqual(["999@s.whatsapp.net"]);

    const documentMedia = await downloadInboundMedia(
      {
        message: {
          documentMessage: {
            mimetype: "application/pdf",
            fileName: "invoice.pdf",
          },
        },
      } as never,
      mockSock,
    );
    expect(documentMedia?.fileName).toBe("invoice.pdf");
    expect(saveMediaBufferSpy).toHaveBeenCalled();
  });

  it("passes mediaMaxMb to saveMediaBuffer", async () => {
    await saveInboundMedia({
      message: { imageMessage: { mimetype: "image/jpeg" } },
      mediaMaxMb: 1,
    });

    expect(saveMediaBufferSpy).toHaveBeenCalled();
    const lastCall = saveMediaBufferSpy.mock.calls.at(-1);
    expect(lastCall?.[3]).toBe(1 * 1024 * 1024);
  });
});
