import { dispatchMessagingRequest } from "../../channels/message/bus.js";
import type { GatewayRequestHandlers } from "./types.js";

export const channelsHandlers: GatewayRequestHandlers = {
  "channels.status": (host) =>
    dispatchMessagingRequest({ method: "channels.status", params: host.params }, host),
  "channels.start": (host) =>
    dispatchMessagingRequest({ method: "channels.start", params: host.params }, host),
  "channels.stop": (host) =>
    dispatchMessagingRequest({ method: "channels.stop", params: host.params }, host),
  "channels.logout": (host) =>
    dispatchMessagingRequest({ method: "channels.logout", params: host.params }, host),
};
