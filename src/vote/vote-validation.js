const strictUtf8 = new TextDecoder("utf-8", { fatal: true });

/** @param {string | Uint8Array | undefined} body */
export function parseVoteJson(body) {
  if (typeof body === "string") {
    if (body.length > 16_384) return undefined;
    try { return JSON.parse(body); } catch { return undefined; }
  }
  if (!(body instanceof Uint8Array) || body.length > 16_384) return undefined;
  try { return JSON.parse(strictUtf8.decode(body)); } catch { return undefined; }
}

/** @param {unknown} body */
export function validateVote(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  const candidate = /** @type {Record<string, unknown>} */ (body);
  if (Object.keys(candidate).length !== 1 || !Object.hasOwn(candidate, "value")) return undefined;
  return candidate.value === 1 || candidate.value === -1 ? candidate.value : undefined;
}
