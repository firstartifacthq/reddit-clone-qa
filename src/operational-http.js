import { methodNotAllowedError, notFoundError } from "./http-errors.js";

export function operationalRequest(method = "GET", target = "/") {
  const path = new URL(target, "http://localhost").pathname;
  if (path === "/health/ready") return method.toUpperCase() === "GET" ? "readiness" : "method-refusal";
  if (path === "/debug/restart") return "not-found";
  return undefined;
}
/** @param {"readiness" | "method-refusal" | "not-found"} operation
 * @param {{observe: () => Promise<boolean>} | undefined} readiness
 */
export async function operationalResponse(operation, readiness) {
  const headers = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
  if (operation === "method-refusal") return { status: 405, headers: { ...headers, allow: "GET" }, body: JSON.stringify(methodNotAllowedError) };
  if (operation === "not-found") return { status: 404, headers, body: JSON.stringify(notFoundError) };
  const ready = await readiness?.observe();
  return { status: ready ? 200 : 503, headers, body: JSON.stringify({ status: ready ? "ready" : "not-ready" }) };
}
