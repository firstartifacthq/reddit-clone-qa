import { readJson } from "./body-parser.js";
import { accountRepresentation } from "./account-representation.js";
import { expiredSessionCookie, readSessionCookie, sessionCookie } from "./cookies.js";
import { invalidRequest, sendJson } from "./auth-errors.js";

export async function signup(request, response, { authService, cookieSecure }) {
  const result = await authService.signup(await readJson(request) ?? {});
  if (!result) return invalidRequest(response);
  sendJson(response, 201, { account: accountRepresentation(result.account) }, { "set-cookie": sessionCookie(result.token, cookieSecure) });
}

export async function login(request, response, { authService, cookieSecure }) {
  const result = await authService.login(await readJson(request) ?? {});
  if (!result) {
    return sendJson(response, 401, { error: { code: "invalid_credentials", message: "Invalid credentials." } });
  }
  sendJson(response, 200, { account: accountRepresentation(result.account) }, { "set-cookie": sessionCookie(result.token, cookieSecure) });
}

export function logout(request, response, { authService, cookieSecure }) {
  authService.logout(readSessionCookie(request.headers.cookie));
  response.writeHead(204, { "cache-control": "no-store", "set-cookie": expiredSessionCookie(cookieSecure) });
  response.end();
}
