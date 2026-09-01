# Reddit Clone QA

A small Node 24 application implementing the RC-01 authentication boundary.

## Local use

- `npm test` runs the composed HTTP authentication scenarios.
- `npm start` serves the application on `PORT` (default `3000`).
- `DATABASE_PATH` selects a local SQLite database (default `./reddit-clone.sqlite`).
- `SESSION_LIFETIME_MS` controls server-side session expiry (default one day).
- `COOKIE_SECURE=true` adds the Secure cookie attribute when serving HTTPS.

No production secret is required. Sessions are opaque HttpOnly cookies; passwords and raw session values are not stored in response bodies.
