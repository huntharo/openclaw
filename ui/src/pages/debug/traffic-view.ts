import { html, nothing } from "lit";
import { guard } from "lit/directives/guard.js";
import "../../components/sparkline-tile.ts";
import { renderSettingsEmpty, renderSettingsSection } from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import { registerDebugEnglish } from "../../i18n/locales/en-debug.ts";
import { formatByteSize } from "../../lib/format.ts";
import "../../styles/gateway-vitals.css";
import type { TrafficSnapshot } from "./traffic-window.ts";

registerDebugEnglish();

const byteFormat = {
  style: "iec",
  maxUnit: "tera",
  separator: " ",
  fractionDigits: (_value, unit) => (unit === "byte" ? 0 : 1),
} satisfies Parameters<typeof formatByteSize>[1];

function formatRate(bytes: number): string {
  return `${formatByteSize(bytes, byteFormat)}/s`;
}

function renderCounters(snapshot: TrafficSnapshot) {
  const maximum = Math.max(
    1,
    ...snapshot.seconds.flatMap((second) => [second.sentBytes, second.receivedBytes]),
  );
  return html`<div class="gateway-vitals">
    ${(["sent", "received"] as const).map(
      (direction) => html`
        <openclaw-sparkline
          class="gateway-vital"
          .label=${t(`debug.traffic.${direction}`)}
          .sub=${t("debug.traffic.total", { bytes: formatByteSize(snapshot[`${direction}Bytes`], byteFormat), frames: String(snapshot[`${direction}Frames`]) })}
          .samples=${snapshot.seconds.map((second) => ({
            at: second.at,
            value: second[`${direction}Bytes`],
            secondary: t("debug.traffic.frameRate", {
              count: String(second[`${direction}Frames`]),
            }),
          }))}
          .format=${formatRate}
          .floorMax=${maximum}
        ></openclaw-sparkline>
      `,
    )}
  </div>`;
}

export function renderTraffic(
  connected: boolean,
  snapshot: TrafficSnapshot | null,
  onToggle: () => void,
) {
  return renderSettingsSection(
    {
      title: t("debug.traffic.title"),
      description: t("debug.traffic.scope"),
      actions: html`<button class="btn" ?disabled=${!connected} @click=${onToggle}>
        ${t(snapshot ? "debug.traffic.stop" : "debug.traffic.start")}
      </button>`,
    },
    html`
      ${guard([snapshot], () => (snapshot ? renderCounters(snapshot) : renderSettingsEmpty(t("debug.traffic.inactive"))))}
      ${snapshot ? html`<div class="settings-row__desc">${t("debug.traffic.refresh")}</div>` : nothing}
    `,
  );
}
