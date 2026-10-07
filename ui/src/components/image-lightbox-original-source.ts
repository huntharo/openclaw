import { BROWSER_IMAGE_MIME_TYPES } from "../../../src/shared/browser-image-mime-types.js";

export function isOriginalImageMimeType(value: string): boolean {
  return BROWSER_IMAGE_MIME_TYPES.has(value.split(";", 1)[0]?.trim().toLowerCase() ?? "");
}

export function isOriginalImageDataUrl(source: string): boolean {
  const mediaType = /^data:([^,]*)/i.exec(source)?.[1];
  return mediaType !== undefined && isOriginalImageMimeType(mediaType);
}
