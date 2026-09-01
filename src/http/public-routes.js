import { sendJson } from "./auth-errors.js";

export function communities(response) {
  sendJson(response, 200, { communities: [] });
}
