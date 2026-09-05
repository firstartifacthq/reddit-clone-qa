import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../src/app.js";
test("AC-RC13-2 administrator audit is denied without a trusted grant", async () => { const app=createApp({databasePath:":memory:"}); const response=await app.inject({method:"GET",path:"/api/admin/audit"}); assert.equal(response.statusCode,401); app.close(); });
