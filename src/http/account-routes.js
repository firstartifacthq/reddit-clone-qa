import { accountRepresentation } from "./account-representation.js";
import { authenticationError, sendJson } from "./auth-errors.js";
import { accountFromRequest } from "./auth-middleware.js";

export function currentAccount(request, response, authService) {
  const account = accountFromRequest(request, authService);
  if (!account) return authenticationError(response);
  sendJson(response, 200, { account: accountRepresentation(account) });
}
