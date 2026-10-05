import { dispatchMessagingRequest } from "../../channels/message/bus.js";
import type { GatewayRequestHandlers } from "./types.js";

export const webHandlers: GatewayRequestHandlers = {
  "web.login.start": (host) =>
    dispatchMessagingRequest({ method: "web.login.start", params: host.params }, host),
  "web.login.wait": (host) =>
    dispatchMessagingRequest({ method: "web.login.wait", params: host.params }, host),
};
