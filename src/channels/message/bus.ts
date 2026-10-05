import type { GatewayRequestHandlerOptions } from "../../gateway/server-methods/types.js";
import { createLazyPromise } from "../../shared/lazy-promise.js";
import type { MessagingRequest } from "./bus-contract.js";

const loadSend = createLazyPromise(() => import("./operations/send.js"), {
  cacheRejections: true,
});
const loadPoll = createLazyPromise(() => import("./operations/poll.js"), {
  cacheRejections: true,
});
const loadAction = createLazyPromise(() => import("./operations/action.js"), {
  cacheRejections: true,
});
const loadStatus = createLazyPromise(() => import("./operations/status.js"), {
  cacheRejections: true,
});
const loadControl = createLazyPromise(() => import("./operations/control.js"), {
  cacheRejections: true,
});

const loadLogin = createLazyPromise(() => import("./operations/login.js"), {
  cacheRejections: true,
});
const loadPairing = createLazyPromise(() => import("./operations/pairing.js"), {
  cacheRejections: true,
});

/**
 * In-process messaging bus. Only the selected operation enters provider admission.
 * The original host object retains non-enumerable authority bindings and request
 * lifetime; neither those capabilities nor provider instances belong in JSON.
 */
export async function dispatchMessagingRequest(
  message: MessagingRequest,
  host: GatewayRequestHandlerOptions,
): Promise<void> {
  if (message.params !== host.params) {
    throw new Error("Messaging request does not match its admitted host invocation");
  }
  switch (message.method) {
    case "web.login.start":
    case "web.login.wait":
      return (await loadLogin()).webHandlers[message.method](host);
    case "channels.pairing.list":
    case "channels.pairing.approve":
    case "channels.pairing.dismiss":
      return (await loadPairing()).channelPairingHandlers[message.method](host);
    case "send":
      return (await loadSend()).sendOperation(host);
    case "poll":
      return (await loadPoll()).pollOperation(host);
    case "message.action":
      return (await loadAction()).messageActionOperation(host);
    case "channels.status":
      return (await loadStatus()).channelStatusOperation(host);
    case "channels.start":
    case "channels.stop":
    case "channels.logout":
      return (await loadControl()).channelControlOperations[message.method](host);
  }
}
