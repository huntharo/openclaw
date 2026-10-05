import { dispatchMessagingRequest } from "../../channels/message/bus.js";
import type { GatewayRequestHandlers } from "./types.js";

export const sendHandlers: GatewayRequestHandlers = {
  send: (host) => dispatchMessagingRequest({ method: "send", params: host.params }, host),
  poll: (host) => dispatchMessagingRequest({ method: "poll", params: host.params }, host),
  "message.action": (host) =>
    dispatchMessagingRequest({ method: "message.action", params: host.params }, host),
};
