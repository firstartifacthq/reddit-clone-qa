const strictUtf8 = new TextDecoder("utf-8", { fatal: true });
const maxPayloadBytes = 65_536;

/** @param {string | Uint8Array | undefined} raw */
export function parseCommentJson(raw) {
  try {
    // @ts-expect-error Buffer is supplied by the supported Node runtime.
    const bytes = typeof raw === "string" ? Buffer.from(raw) : raw;
    if (!(bytes instanceof Uint8Array) || bytes.length > maxPayloadBytes) return undefined;
    return JSON.parse(strictUtf8.decode(bytes));
  } catch { return undefined; }
}

/** @param {unknown} value */
function body(value) {
  return typeof value === "string" && [...value].length >= 1 && [...value].length <= 10_000 && /\S/u.test(value) ? value : undefined;
}
/** @param {unknown} candidate @param {string[]} keys */
function exactKeys(candidate, keys) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return undefined;
  const record = /** @type {Record<string, unknown>} */ (candidate);
  return Object.keys(record).length === keys.length && keys.every((key) => Object.hasOwn(record, key)) ? record : undefined;
}
/** @param {unknown} payload */
export function validateCommentCreate(payload) {
  const record = exactKeys(payload, ["body"]) || exactKeys(payload, ["body", "parentId"]);
  const value = record && body(record.body);
  if (!value) return { kind: "invalid" };
  if (Object.hasOwn(record, "parentId") && (typeof record.parentId !== "string" || record.parentId.length === 0)) return { kind: "invalid" };
  return { kind: "valid", body: value, parentId: record.parentId ?? null };
}
/** @param {unknown} payload */
export function validateCommentPatch(payload) {
  const record = exactKeys(payload, ["body"]);
  const value = record && body(record.body);
  return value ? { kind: "valid", body: value } : { kind: "invalid" };
}
/** @param {URLSearchParams} params */
export function validateCommentPage(params) {
  const limits = params.getAll("limit");
  const cursors = params.getAll("cursor");
  if (limits.length > 1 || cursors.length > 1) return undefined;
  const rawLimit = limits[0] ?? "25";
  if (!/^(?:[1-9]|[1-9][0-9]{1,2})$/.test(rawLimit)) return undefined;
  const limit = Number(rawLimit);
  if (limit < 1 || limit > 100) return undefined;
  const cursor = cursors[0];
  return cursor === undefined || (cursor.length >= 1 && cursor.length <= 128) ? { limit, cursor } : undefined;
}
