import {
  ErrorCodes,
  errorShape,
} from "../../../packages/gateway-protocol/src/schema/error-codes.js";
import type { SessionOperatorScope } from "../../shared/session-method-scopes-base.js";
import type { GatewaySessionAccessAuthority } from "../session-access-authority.js";
import { SessionMutationAuthorizationChangedError } from "../session-mutation-authorization-error.js";
import type { RespondFn, SessionMutationAuthorization } from "./types.js";

export function guardSessionResponse(params: {
  respond: RespondFn;
  readResource: boolean;
  sessionScope?: SessionOperatorScope;
  sessionAccessAuthority?: GatewaySessionAccessAuthority;
  sessionMutationAuthorization?: SessionMutationAuthorization;
}): RespondFn {
  const {
    respond,
    readResource,
    sessionScope,
    sessionAccessAuthority,
    sessionMutationAuthorization,
  } = params;
  return sessionScope === "operator.sessions.read" || readResource
    ? (...response) => {
        try {
          if (readResource && response[0]) {
            if (!sessionAccessAuthority) {
              respond(
                false,
                undefined,
                errorShape(ErrorCodes.FORBIDDEN, "Session read authority is unavailable"),
              );
              return;
            }
            sessionAccessAuthority.assertCurrent();
          }
          if (sessionScope === "operator.sessions.read") {
            sessionMutationAuthorization?.assertCurrent();
          }
        } catch (error) {
          if (!(error instanceof SessionMutationAuthorizationChangedError)) {
            throw error;
          }
          respond(false, undefined, error.error);
          return;
        }
        respond(...response);
      }
    : respond;
}
