# Reddit clone QA

A local, server-rendered authentication slice for the RC-01 campaign. It uses Node 24's built-in SQLite support and opaque, server-side session records; no production secret is read or required.

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
- `GET /api/me`
- `GET /api/communities`
- `POST /api/communities`
- `POST /api/communities/{community}/members`
- `DELETE /api/communities/{community}/members/me`
- `PATCH /api/communities/{community}/moderators`
- `GET /api/communities/{community}/modlog`
- `GET /`

Authentication requests accept JSON with `username` and `password`. Successful signup and login return only an account's `id` and `username`; the opaque session is delivered solely in an `HttpOnly` cookie.

Authenticated users can create canonical community names (ASCII-trimmed, ASCII-lowercased, and matching `^[a-z0-9_]{3,21}$`). Creation makes the requester the community `owner`; joining is idempotent and creates a `member` role only when no membership exists. Owners can toggle existing non-owner members between `member` and `moderator`; owners and moderators can read the empty moderator log representation. Public community discovery returns only canonical names.

Run `npm run typecheck`, `npm test`, and `npm run build` before submitting changes.
