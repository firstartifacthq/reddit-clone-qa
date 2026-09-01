const cookieName = "reddit_session";

export function readSessionCookie(header) {
  for (const part of String(header ?? "").split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name === cookieName && value.length === 1 && /^[A-Za-z0-9_-]{20,}$/.test(value[0])) return value[0];
  }
  return null;
}

export function sessionCookie(token, secure = false) {
  return `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}

export function expiredSessionCookie(secure = false) {
  return `${cookieName}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}
