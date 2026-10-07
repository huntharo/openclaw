import type { ImageLightboxItem } from "../../../components/image-lightbox.types.ts";
import { openExternalUrlSafe, resolveSafeExternalUrl } from "../../../lib/open-external-url.ts";

export function openResolvedImage(
  onOpenImage: ((item: ImageLightboxItem, requestVersion?: number) => void) | undefined,
  src: string,
  title: string,
  release?: () => void,
  requestVersion?: number,
  svgSource?: ImageLightboxItem["svgSource"],
) {
  const safeSrc = resolveSafeExternalUrl(src, window.location.href, { allowDataImage: true });
  if (!safeSrc) {
    release?.();
    return;
  }
  if (onOpenImage) {
    const item: ImageLightboxItem = {
      src: safeSrc,
      title,
      ...(release ? { release } : {}),
      ...(svgSource ? { svgSource } : {}),
    };
    if (requestVersion === undefined) {
      onOpenImage(item);
    } else {
      onOpenImage(item, requestVersion);
    }
    return;
  }
  release?.();
  openExternalUrlSafe(safeSrc, { allowDataImage: true });
}
