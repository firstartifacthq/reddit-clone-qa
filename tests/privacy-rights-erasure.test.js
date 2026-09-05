import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../src/app.js";
test("AC-RC13-7A deletion removes the active account", async () => { const work=[]; const app=createApp({databasePath:":memory:",schedulePrivacyWork:(f)=>work.push(f)}); const signup=await app.inject({method:"POST",path:"/api/auth/signup",payload:JSON.stringify({username:"erase",password:"privacy-pass-123"})}); const cookie=signup.headers.get("set-cookie").split(";")[0]; const deletion=await app.inject({method:"DELETE",path:"/api/me",headers:{cookie}}); assert.equal(deletion.statusCode,202); work.at(-1)(); assert.equal(app.database.prepare("SELECT COUNT(*) AS count FROM users WHERE username='erase'").get().count,0); app.close(); });
