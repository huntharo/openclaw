import { dispatchMessagingRequest } from "../../channels/message/bus.js";
import type { GatewayRequestHandlers } from "./types.js";

export const channelPairingHandlers: GatewayRequestHandlers = {
  "channels.pairing.list": (host) =>
    dispatchMessagingRequest({ method: "channels.pairing.list", params: host.params }, host),
  "channels.pairing.approve": (host) =>
    dispatchMessagingRequest({ method: "channels.pairing.approve", params: host.params }, host),
  "channels.pairing.dismiss": (host) =>
    dispatchMessagingRequest({ method: "channels.pairing.dismiss", params: host.params }, host),
};
