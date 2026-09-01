import { readSessionCookie } from "./cookies.js";

export function accountFromRequest(request, authService) {
  return authService.currentAccount(readSessionCookie(request.headers.cookie));
}
