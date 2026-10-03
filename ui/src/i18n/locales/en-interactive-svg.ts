import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const enInteractiveSvg = {
  chat: {
    imageLightbox: {
      svgInteract: "Interact with SVG",
      svgPreview: "Show image preview",
      svgLabel: "Isolated SVG: {title}",
      svgInteractionHelp:
        "Run this SVG's scripts and controls in an isolated view. The SVG cannot access OpenClaw or navigate the parent page, but can navigate its own frame.",
      svgInvalid:
        "This SVG could not be opened for interaction. Use the image preview or choose Interact with SVG to retry.",
      svgLoading: "Loading SVG controls…",
      svgSearch: "Search SVG frames",
      svgSearchSubmit: "Find",
      svgSearchError: "The SVG could not run this search. Check the expression and try again.",
      svgEncodingUnsupported:
        "This SVG's text encoding cannot be used interactively. The image preview is still available.",
    },
  },
} satisfies TranslationMap;

export const registerInteractiveSvgEnglish = Object.assign(
  () => Object.assign(en.chat.imageLightbox, enInteractiveSvg.chat.imageLightbox),
  { catalog: enInteractiveSvg },
);
