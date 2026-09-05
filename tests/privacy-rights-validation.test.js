import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../src/app.js";
test("AC-RC13-3 export owner override is rejected before a job", async () => { const app=createApp({databasePath:":memory:"}); const signed=await app.inject({method:"POST",path:"/api/auth/signup",payload:JSON.stringify({username:"valid",password:"privacy-pass-123"})}); const response=await app.inject({method:"POST",path:"/api/me/export",headers:{cookie:signed.headers.get("set-cookie").split(";")[0]},payload:"{}"}); assert.equal(response.statusCode,422); assert.equal(app.database.prepare("SELECT COUNT(*) AS count FROM privacy_jobs").get().count,0); app.close(); });
