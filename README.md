# Reddit clone QA

A local, server-rendered authentication, community, post, comment, and vote slice for the RC-06 campaign. It uses Node 24's built-in SQLite support and opaque, server-side session records; no production secret is read or required.

## Run locally

```sh
npm ci
npm start
```

Optional non-secret configuration is captured when the application starts:

- `PORT` (default `3000`)
- `DATABASE_PATH` (default `./reddit.sqlite`)
- `SESSION_LIFETIME_MS` (default one hour)
- `FEED_TRAVERSAL_LIFETIME_MS` (default 24 hours)
- `SESSION_COOKIE_NAME` (default `reddit_session`)
- `NODE_ENV=production` enables the cookie `Secure` attribute

## HTTP surface

- `POST /api/auth/signup`
- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET`, `PATCH`, and `DELETE /api/me`
- `GET /api/users/:username`
- `GET /api/communities`
- `GET /api/feed/home`
- `GET /api/feed/popular`
- `GET /api/communities/:canonicalName/feed`
- `POST /api/communities`
- `POST /api/communities/:canonicalName/members`
- `DELETE /api/communities/:canonicalName/members/me`
- `PATCH /api/communities/:canonicalName/moderators`
- `GET /api/communities/:canonicalName/modlog`
- `POST /api/communities/:canonicalName/posts`
- `GET`, `PATCH`, and `DELETE /api/posts/:id`
- `GET`, `PUT`, and `DELETE /api/posts/:id/vote`
- `GET /api/posts/:id/media`
- `POST`, `GET /api/posts/:id/comments`
- `GET`, `PATCH`, and `DELETE /api/comments/:id`
- `GET /`

Authentication requests accept JSON with `username` and `password`. Successful signup and login return only an account's `id` and `username`; the opaque session is delivered solely in an `HttpOnly` cookie.

`GET /api/me` and successful `PATCH /api/me` return the owner profile: `id`, `username`, `bio`, and integer `revision`. Public lookups return only `id`, `username`, and `bio`. Usernames use ASCII-only surrounding-whitespace trimming, must be 3 through 32 ASCII letters, digits, underscores, or hyphens, and are unique without regard to ASCII case. Bios contain up to 500 Unicode code points; an empty string clears a bio.

A successful `DELETE /api/me` marks the account deletion-requested and revokes every session atomically. The account can no longer log in, authorize requests, or appear through public lookup, while its username remains reserved. Physical erasure and reactivation are intentionally out of scope.

Authenticated active users can create a community with a 3 through 21 character ASCII letter, digit, or underscore name. Names are ASCII-trimmed and case-folded for uniqueness. Creation makes the creator the immutable owner; joining is idempotent, non-owners can leave, and only the owner can promote or demote an existing active member. The public list contains canonical community names in deterministic order.

Current members can publish JSON text, HTTP(S) link, or image media posts. Media uploads use canonical base64 in the JSON request and are stored with their metadata in the local SQLite database; media reads return the accepted bytes with their declared image content type. Post creation accepts an optional `Idempotency-Key` for safe retries. Only the author can edit declared-form fields or delete a post.

Authenticated active users can set or replace their own vote as JSON `{ "value": 1 }` or `{ "value": -1 }` on another active author's unlocked post, inspect their current vote, or clear it. Vote score and author karma are derived from current durable votes; no vote ledger or aggregate override route is exposed.

Active community members can add JSON comments to a readable post, either top-level or with a same-post `parentId`. Conversations are depth-first pre-order pages; `limit` defaults to 25 and accepts 1 through 100. Returned cursors are opaque, resumable snapshots, so later comments do not enter an existing traversal. Comment authors may edit active comments or replace them with privacy-preserving tombstones while descendants retain their original nesting.

Feed reads return `{ "posts": [...], "nextCursor": string|null }`. Home requires an active account and includes only its current community memberships; popular and community feeds are publicly readable under the existing direct post-read rules. Fresh feeds rank by current vote score, then durable post creation order, then post ID. Each cursor references a durable, account- and scope-bound snapshot for up to `FEED_TRAVERSAL_LIFETIME_MS`; later votes, posts, and membership changes appear only in a fresh traversal. `limit` defaults to 25 and accepts one decimal integer from 1 through 100.

Run `npm run typecheck`, `npm test`, and `npm run build` before submitting changes.
