import assert from "node:assert/strict";
import test from "node:test";
import { fixture, password } from "../tools/rc14-fixture.js";
import { launchBrowser, tabTo, geometry, observeShell, browserMetadata } from "../tools/rc14-browser.js";

async function type(page, locator, value) { await tabTo(page, locator); await page.keyboard.press("ControlOrMeta+A"); await page.keyboard.type(value); }
async function submit(page, form, button) { await tabTo(page, form.getByRole("button", { name: button, exact: true })); await page.keyboard.press("Enter"); }
async function authority(page) { return page.evaluate(async () => (await fetch("/api/me")).status); }
async function feedback(page, expression) {
  await page.getByRole("alert").filter({ hasText: expression }).waitFor();
}
test("sealed browser keyboard authentication, interruptions, semantics and responsive boundaries", async () => {
  const browser = await launchBrowser();
  const f = await fixture();
  try {
    for (const width of [320, 768, 1280]) for (const textSize of [100, 200]) {
      const context = await browser.newContext({ viewport: { width, height: 900 } });
      await context.addInitScript(size => document.addEventListener('DOMContentLoaded', () => {
        document.documentElement.style.fontSize = size + '%';
      }), textSize);
      const page = await context.newPage();
      try {
        assert.equal((await page.goto(f.origin)).status(), 200);
        const signup = page.getByRole("form", { name: "Sign up", exact: true });
        const login = page.getByRole("form", { name: "Sign in", exact: true });
        assert.equal(await page.getByRole("main").count(), 1);
        assert.equal(await page.getByRole("navigation", { name: "Account navigation" }).count(), 1);
        await observeShell(page, { signedIn: false, name: `${width}-${textSize}-anonymous`, textSize });
        await submit(page, signup, "Create account");
        assert.equal(await authority(page), 401);
        assert.equal(await signup.getByLabel("Username", { exact: true }).evaluate(element => element === document.activeElement && !element.validity.valid), true);
        const username = `browser-${width}-${textSize}`;
        await type(page, signup.getByLabel("Username", { exact: true }), username);
        await type(page, signup.getByLabel("Passphrase", { exact: true }), password);
        await submit(page, signup, "Create account");
        await page.getByRole("button", { name: "Log out" }).waitFor();
        assert.equal(await authority(page), 200);
        assert.equal(await page.locator('html').evaluate(e => parseFloat(getComputedStyle(e).fontSize)), 16 * textSize / 100);
        const cookie = (await context.cookies())[0];
        await observeShell(page, { signedIn: true, name: `${width}-${textSize}-signed-in`, textSize });
        for (const name of ["Account", "Communities"]) {
          await tabTo(page, page.getByRole("link", { name, exact: true }));
          await page.keyboard.press("Enter"); await page.waitForURL(`**/api/${name === "Account" ? "me" : "communities"}`);
          await page.goBack();
        }
        await tabTo(page, page.getByRole("button", { name: "Log out" }), true);
        await page.keyboard.press("Space"); await signup.waitFor();
        assert.equal(await authority(page), 401);
        assert.equal((await f.request("/api/me", "GET", undefined, `${cookie.name}=${cookie.value}`)).status, 401);
        await type(page, login.getByLabel("Username", { exact: true }), username);
        await type(page, login.getByLabel("Passphrase", { exact: true }), "wrong-password");
        await submit(page, login, "Sign in"); await feedback(page, /Unable to sign in/);
        assert.equal(await authority(page), 401);
        await observeShell(page, { signedIn: false, feedback: 'Unable to sign in', name: `${width}-${textSize}-rejected`, textSize });
        await type(page, login.getByLabel("Passphrase", { exact: true }), password);
        await page.route("**/api/auth/login", route => route.abort("failed"));
        await submit(page, login, "Sign in"); await feedback(page, /not confirmed/);
        assert.equal(await authority(page), 401);
        await page.unroute("**/api/auth/login");
        await submit(page, login, "Sign in"); await page.getByRole("button", { name: "Log out" }).waitFor();
        assert.equal(await authority(page), 200);
        await tabTo(page, page.getByRole("button", { name: "Log out" }));
        const focused = await page.evaluate(() => { const e = document.activeElement; const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return { outline: s.outlineStyle, width: parseFloat(s.outlineWidth), hit: document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) === e }; });
        assert.equal(focused.outline, "solid"); assert.ok(focused.width >= 2); assert.equal(focused.hit, true);
        await page.route("**/api/auth/logout", route => route.fulfill({ status: 503, body: "unavailable" }));
        await page.keyboard.press("Enter"); await feedback(page, /Unable to log out/);
        assert.equal(await authority(page), 200);
        await page.unroute("**/api/auth/logout");
        await page.keyboard.press("Enter"); await signup.waitFor();
        // The server may commit before a response is interrupted; never claim success from that response.
        await type(page, login.getByLabel("Username", { exact: true }), username);
        await type(page, login.getByLabel("Passphrase", { exact: true }), password);
        await page.route("**/api/auth/login", async route => { await route.fetch(); await route.abort(); });
        await submit(page, login, "Sign in"); await feedback(page, /not confirmed/);
        assert.equal(await page.getByRole("button", { name: "Log out" }).count(), 0);
        await page.unroute("**/api/auth/login");
        await submit(page, login, "Sign in"); await page.getByRole("button", { name: "Log out" }).waitFor();
        assert.equal(await authority(page), 200);
      } finally { await context.close(); }
    }
    console.log(JSON.stringify({ browser: browserMetadata, widths: [320, 768, 1280], textPercent: [100, 200], textMethod: "CSS root text enlargement; not browser zoom or screen-reader speech" }));
  } finally { await browser.close(); await f.close(); }
});
