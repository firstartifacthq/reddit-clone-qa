# Reddit clone QA

A local, server-rendered authentication, community, and post slice for the RC-04 campaign. It uses Node 24's built-in SQLite support and opaque, server-side session records; no production secret is read or required.

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
- `GET`, `PATCH`, and `DELETE /api/me`
- `GET /api/users/:username`
- `GET /api/communities`
- `POST /api/communities`
- `POST /api/communities/:canonicalName/members`
- `DELETE /api/communities/:canonicalName/members/me`
- `PATCH /api/communities/:canonicalName/moderators`
- `GET /api/communities/:canonicalName/modlog`
- `POST /api/communities/:canonicalName/posts`
- `GET`, `PATCH`, and `DELETE /api/posts/:id`
- `GET /api/posts/:id/media`
- `GET /`

Authentication requests accept JSON with `username` and `password`. Successful signup and login return only an account's `id` and `username`; the opaque session is delivered solely in an `HttpOnly` cookie.

`GET /api/me` and successful `PATCH /api/me` return the owner profile: `id`, `username`, `bio`, and integer `revision`. Public lookups return only `id`, `username`, and `bio`. Usernames use ASCII-only surrounding-whitespace trimming, must be 3 through 32 ASCII letters, digits, underscores, or hyphens, and are unique without regard to ASCII case. Bios contain up to 500 Unicode code points; an empty string clears a bio.

A successful `DELETE /api/me` marks the account deletion-requested and revokes every session atomically. The account can no longer log in, authorize requests, or appear through public lookup, while its username remains reserved. Physical erasure and reactivation are intentionally out of scope.

Authenticated active users can create a community with a 3 through 21 character ASCII letter, digit, or underscore name. Names are ASCII-trimmed and case-folded for uniqueness. Creation makes the creator the immutable owner; joining is idempotent, non-owners can leave, and only the owner can promote or demote an existing active member. The public list contains canonical community names in deterministic order.

Current members can publish JSON text, HTTP(S) link, or image media posts. Media uploads use canonical base64 in the JSON request and are stored with their metadata in the local SQLite database; media reads return the accepted bytes with their declared image content type. Post creation accepts an optional `Idempotency-Key` for safe retries. Only the author can edit declared-form fields or delete a post.

Run `npm run typecheck`, `npm test`, and `npm run build` before submitting changes.
