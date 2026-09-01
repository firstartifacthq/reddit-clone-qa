import { asciiTrim } from "../community/community-validation.js";

const mediaTypes = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

/** @param {unknown} value */
function codePoints(value) { return typeof value === "string" ? [...value].length : -1; }
/** @param {unknown} body @param {string[]} keys */
function exactKeys(body, keys) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  const candidate = /** @type {Record<string, unknown>} */ (body);
  return Object.keys(candidate).length === keys.length && keys.every((key) => Object.hasOwn(candidate, key)) ? candidate : undefined;
}
/** @param {unknown} value */
function title(value) {
  if (typeof value !== "string") return undefined;
  const trimmed = asciiTrim(value);
  return codePoints(trimmed) >= 1 && codePoints(trimmed) <= 300 ? trimmed : undefined;
}
/** @param {unknown} value */
function text(value) {
  if (typeof value !== "string" || codePoints(value) < 1 || codePoints(value) > 40_000 || !/\S/u.test(value)) return undefined;
  return value;
}
/** @param {unknown} value */
function url(value) {
  if (typeof value !== "string" || codePoints(value) < 1 || codePoints(value) > 2_048 || /\p{Cc}/u.test(value) || !/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value)) return undefined;
  try {
    const parsed = new URL(value);
    return (parsed.protocol === "http:" || parsed.protocol === "https:") && !parsed.username && !parsed.password ? value : undefined;
  } catch { return undefined; }
}
/** @param {unknown} value */
function filename(value) {
  if (typeof value !== "string") return undefined;
  const trimmed = asciiTrim(value);
  return codePoints(trimmed) >= 1 && codePoints(trimmed) <= 255 ? trimmed : undefined;
}
/** @param {string} contentType @param {Uint8Array} bytes */
function signatureMatches(contentType, bytes) {
  /** @param {number[]} values */
  const starts = (...values) => values.every((value, index) => bytes[index] === value);
  if (contentType === "image/jpeg") return starts(0xff, 0xd8, 0xff);
  if (contentType === "image/png") return starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
  if (contentType === "image/gif") return starts(0x47, 0x49, 0x46, 0x38) && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61;
  return starts(0x52, 0x49, 0x46, 0x46) && bytes.length >= 12 && starts(0x52, 0x49, 0x46, 0x46) && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50;
}
/** @param {unknown} value */
function media(value) {
  const candidate = exactKeys(value, ["filename", "contentType", "bytesBase64"]);
  if (!candidate || typeof candidate.contentType !== "string" || typeof candidate.bytesBase64 !== "string") return { kind: "invalid" };
  const storedFilename = filename(candidate.filename);
  if (!storedFilename || !mediaTypes.has(candidate.contentType)) return { kind: "invalid" };
  const base64 = candidate.bytesBase64;
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  const unpadded = padding ? base64.slice(0, -padding) : base64;
  // Avoid a nested repeated regex here: V8 can exhaust its stack on a valid 5 MiB upload.
  if (base64.length === 0 || base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*$/.test(unpadded)) return { kind: "invalid" };
  // Buffer's exact round trip rejects permissive and non-canonical encodings.
  // @ts-expect-error Buffer is supplied by the supported Node runtime.
  const bytes = Buffer.from(base64, "base64");
  if (bytes.toString("base64") !== base64 || bytes.length === 0) return { kind: "invalid" };
  if (bytes.length > 5_242_880) return { kind: "too-large" };
  if (!signatureMatches(candidate.contentType, bytes)) return { kind: "invalid" };
  return { kind: "valid", media: { filename: storedFilename, contentType: candidate.contentType, bytes } };
}

/** @param {unknown} body */
export function validatePostCreate(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { kind: "invalid" };
  const type = /** @type {Record<string, unknown>} */ (body).type;
  if (type === "text") {
    const candidate = exactKeys(body, ["type", "title", "text"]);
    const storedTitle = candidate && title(candidate.title);
    const storedText = candidate && text(candidate.text);
    return storedTitle && storedText ? { kind: "valid", post: { type, title: storedTitle, text: storedText } } : { kind: "invalid" };
  }
  if (type === "link") {
    const candidate = exactKeys(body, ["type", "title", "url"]);
    const storedTitle = candidate && title(candidate.title);
    const storedUrl = candidate && url(candidate.url);
    return storedTitle && storedUrl ? { kind: "valid", post: { type, title: storedTitle, url: storedUrl } } : { kind: "invalid" };
  }
  if (type === "media") {
    const candidate = exactKeys(body, ["type", "title", "media"]);
    const storedTitle = candidate && title(candidate.title);
    const storedMedia = candidate && media(candidate.media);
    if (!storedTitle || !storedMedia || storedMedia.kind === "invalid") return { kind: "invalid" };
    if (storedMedia.kind === "too-large") return storedMedia;
    return { kind: "valid", post: { type, title: storedTitle, media: storedMedia.media } };
  }
  return { kind: "invalid" };
}

/** @param {"text" | "link" | "media"} type @param {unknown} body */
export function validatePostPatch(type, body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { kind: "invalid" };
  const candidate = /** @type {Record<string, unknown>} */ (body);
  const field = type === "text" ? "text" : type === "link" ? "url" : "media";
  const keys = Object.keys(candidate);
  if (keys.length === 0 || keys.some((key) => key !== "title" && key !== field)) return { kind: "invalid" };
  /** @type {{title?: string, text?: string, url?: string, media?: {filename: string, contentType: string, bytes: Uint8Array}}} */
  const patch = {};
  if (Object.hasOwn(candidate, "title")) {
    const storedTitle = title(candidate.title);
    if (!storedTitle) return { kind: "invalid" };
    patch.title = storedTitle;
  }
  if (Object.hasOwn(candidate, field)) {
    if (field === "text") { const storedText = text(candidate.text); if (!storedText) return { kind: "invalid" }; patch.text = storedText; }
    if (field === "url") { const storedUrl = url(candidate.url); if (!storedUrl) return { kind: "invalid" }; patch.url = storedUrl; }
    if (field === "media") { const storedMedia = media(candidate.media); if (storedMedia.kind !== "valid") return storedMedia; patch.media = storedMedia.media; }
  }
  return { kind: "valid", patch };
}

/** @param {unknown} value */
export function validateIdempotencyKey(value) {
  return typeof value === "string" && /^[\x21-\x7e]{1,128}$/.test(value) ? value : undefined;
}
