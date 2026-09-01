# Reddit clone QA

A local, server-rendered authentication and profile slice for the RC-01 and RC-02 campaigns. It uses Node 24's built-in SQLite support and opaque, server-side session records; no production secret is read or required.

## Run locally

```sh
npm ci
npm start
```

Optional non-secret configuration is captured when the application starts:

- `PORT` (default `3000`)
- `DATABASE_PATH` (default `./reddit.sqlite`)
- `SESSION_LIFETIME_MS` (default one hour)
- `SESSION_COOKIE_NAME` (default `reddit_session`)
- `NODE_ENV=production` enables the cookie `Secure` attribute

## HTTP surface

- `POST /api/auth/signup`
- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET /api/me` returns the authenticated owner profile: `id`, `username`, `bio`, and `revision`.
- `PATCH /api/me` updates a non-empty subset of `username` and `bio` and returns the committed owner profile.
- `DELETE /api/me` accepts logical deletion, revokes every session, clears the current cookie, and returns `202`.
- `GET /api/users/{username}` anonymously returns only the public profile: `id`, `username`, and `bio`.
- `GET /api/communities`
- `GET /`

Successful signup and login return only an account's `id` and `username`; the opaque session is delivered solely in an `HttpOnly` cookie. Usernames trim surrounding ASCII whitespace and must be 3 through 32 ASCII letters, digits, underscores, or hyphens. They are unique without regard to ASCII letter case. Bios may contain 0 through 500 Unicode code points; omitting a field leaves it unchanged and an empty bio clears it.

Deletion is immediate logical deletion: the profile is no longer publicly readable, retained sessions and credentials lose authority, and the username remains reserved. Profile and lifecycle data use the local SQLite database; physical erasure and reactivation are intentionally out of scope.

Run `npm run typecheck`, `npm test`, and `npm run build` before submitting changes.
