const strictUtf8 = new TextDecoder("utf-8", { fatal: true });

/** @param {string} source */
function hasOneTopLevelMember(source) {
  let depth = 0; let members = 0; let inString = false; let escaped = false;
  for (const character of source) {
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
    } else if (character === '"') inString = true;
    else if (character === "{" || character === "[") depth += 1;
    else if (character === "}" || character === "]") depth -= 1;
    else if (character === ":" && depth === 1) members += 1;
  }
  return members === 1;
}

/** @param {string | Uint8Array | undefined} raw */
export function parseReportJson(raw) {
  try {
    // @ts-expect-error Buffer is supplied by the supported Node runtime.
    const bytes = typeof raw === "string" ? Buffer.from(raw) : raw;
    if (!(bytes instanceof Uint8Array) || bytes.length > 16_384) return undefined;
    const source = strictUtf8.decode(bytes);
    const value = JSON.parse(source);
    return hasOneTopLevelMember(source) ? value : undefined;
  } catch { return undefined; }
}

/** @param {unknown} candidate */
export function validateReport(candidate) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return undefined;
  const value = /** @type {Record<string, unknown>} */ (candidate);
  if (Object.keys(value).length !== 1 || !Object.hasOwn(value, "reason") || typeof value.reason !== "string") return undefined;
  const reason = value.reason.trim();
  return [...reason].length >= 1 && [...reason].length <= 500 ? reason : undefined;
}

/** @param {URLSearchParams} params */
export function validateModerationPage(params) {
  const names = [...params.keys()];
  if (names.some((name) => name !== "limit" && name !== "cursor")) return undefined;
  const limits = params.getAll("limit"); const cursors = params.getAll("cursor");
  if (limits.length > 1 || cursors.length > 1) return undefined;
  const rawLimit = limits[0] ?? "25";
  if (!/^(?:[1-9]|[1-9][0-9]{1,2})$/.test(rawLimit)) return undefined;
  const limit = Number(rawLimit);
  const cursor = cursors[0];
  if (limit > 100 || (cursor !== undefined && !/^[A-Za-z0-9_-]{1,128}$/.test(cursor))) return undefined;
  return { limit, cursor };
}
