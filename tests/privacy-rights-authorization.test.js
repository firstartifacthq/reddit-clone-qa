import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../src/app.js";
test("AC-RC13-4 ordinary account cannot read administration", async () => { const app=createApp({databasePath:":memory:"}); const signed=await app.inject({method:"POST",path:"/api/auth/signup",payload:JSON.stringify({username:"member",password:"privacy-pass-123"})}); const response=await app.inject({method:"GET",path:"/api/admin/audit",headers:{cookie:signed.headers.get("set-cookie").split(";")[0]}}); assert.equal(response.statusCode,403); app.close(); });
