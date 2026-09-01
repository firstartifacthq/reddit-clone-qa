import { sendJson } from "./auth-errors.js";

export function notFound(response) {
  sendJson(response, 404, { error: { code: "not_found", message: "Not found." } });
}
