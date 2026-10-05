/** The existing JSON RPC vocabulary; providers never receive the host invocation. */
export type MessagingRequest = {
  method:
    | "send"
    | "poll"
    | "message.action"
    | "channels.status"
    | "channels.start"
    | "channels.stop"
    | "channels.logout"
    | "web.login.start"
    | "web.login.wait"
    | "channels.pairing.list"
    | "channels.pairing.approve"
    | "channels.pairing.dismiss";
  /** Untrusted wire data, validated by the operation's canonical protocol schema. */
  params: Record<string, unknown>;
};
