import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../src/app.js";
test("AC-RC13-5 unauthenticated deletion has no effect", async () => { const app=createApp({databasePath:":memory:"}); const result=await app.inject({method:"DELETE",path:"/api/me"}); assert.equal(result.statusCode,401); assert.equal(app.database.prepare("SELECT COUNT(*) AS count FROM privacy_jobs").get().count,0); app.close(); });
