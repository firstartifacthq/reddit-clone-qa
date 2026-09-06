import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync, realpathSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

export const browserMetadata = Object.freeze({
  image: "sha256:507836265d75817d6463538211a832318994ad5753198866693bd0537b819325",
  playwright: "1.63.0", chromium: "153.0.8010.12", revision: "1243",
  modulePath: "/usr/local/lib/node_modules/playwright", cachePath: "/opt/software-factory/playwright-browsers",
});
export async function launchBrowser() {
  const expected = browserMetadata;
  assert.equal(process.env.FACTORY_PLAYWRIGHT_MODULE_PATH || expected.modulePath, expected.modulePath, "sealed Playwright module mismatch");
  assert.equal(process.env.PLAYWRIGHT_BROWSERS_PATH || expected.cachePath, expected.cachePath, "sealed browser cache mismatch");
  process.env.PLAYWRIGHT_BROWSERS_PATH = expected.cachePath;
  const require = createRequire(expected.modulePath + "/package.json");
  assert.equal(require("./package.json").version, expected.playwright);
  const core = createRequire(require.resolve("playwright-core/package.json"));
  const manifest = JSON.parse(readFileSync(core.resolve("./browsers.json"), "utf8"));
  const chromium = manifest.browsers.find(entry => entry.name === "chromium");
  assert.equal(chromium.revision, expected.revision); assert.equal(chromium.browserVersion, expected.chromium);
  const playwright = require(expected.modulePath);
  const executablePath = realpathSync(playwright.chromium.executablePath());
  assert.ok(executablePath.startsWith(expected.cachePath + "/chromium-1243/"));
  const browser = await playwright.chromium.launch({ executablePath, headless: true });
  try { assert.equal(browser.version(), expected.chromium); }
  catch (error) { await browser.close(); throw error; }
  return browser;
}
export async function tabTo(page, locator, backwards = false) {
  for (let step = 0; step < 30; step++) {
    if (await locator.evaluate(element => element === document.activeElement)) {
      const focus = await locator.evaluate(e => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return { style: s.outlineStyle, width: parseFloat(s.outlineWidth), hit: document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) === e }; });
      assert.equal(focus.style, "solid"); assert.ok(focus.width >= 2); assert.equal(focus.hit, true);
      return;
    }
    await page.keyboard.press(backwards ? "Shift+Tab" : "Tab");
  }
  assert.fail("critical control unreachable with keyboard");
}
export async function geometry(page) {
  const result = await page.evaluate(() => ({
    overflow: document.documentElement.scrollWidth > innerWidth,
    controls: [...document.querySelectorAll("a,input,button")].map(element => {
      const rect = element.getBoundingClientRect();
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width };
    }), width: innerWidth,
  }));
  assert.equal(result.overflow, false);
  for (const rect of result.controls) { assert.ok(rect.width > 0); assert.ok(rect.left >= 0 && rect.right <= result.width); }
  for (let i = 0; i < result.controls.length; i++) for (let j = i + 1; j < result.controls.length; j++) {
    const a = result.controls[i]; const b = result.controls[j];
    assert.ok(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top, "critical controls overlap");
  }
}
export async function observeShell(page, { signedIn, feedback = "", name, textSize }) {
  await geometry(page);
  assert.equal(await page.locator('html').evaluate(e => parseFloat(getComputedStyle(e).fontSize)), 16 * textSize / 100);
  const tree = await page.locator('body').ariaSnapshot();
  assert.match(tree, /main:/); assert.match(tree, /heading "Reddit clone" \[level=1\]/);
  assert.match(tree, /navigation "Account navigation"/);
  assert.match(tree, /link "Communities"/);
  if (signedIn) {
    assert.match(tree, /link "Account"/); assert.match(tree, /form "Sign out"/); assert.match(tree, /button "Log out"/);
  } else {
    assert.ok(tree.indexOf('form "Sign up"') < tree.indexOf('form "Sign in"'));
    for (const name of ['Sign up', 'Sign in']) {
      const form = page.getByRole('form', { name, exact: true });
      for (const label of ['Username', 'Passphrase']) assert.equal(await form.getByLabel(label, { exact: true }).count(), 1);
    }
  }
  const live = await page.getByRole('alert').evaluate(e => ({ text: e.textContent, live: e.getAttribute('aria-live'), atomic: e.getAttribute('aria-atomic') }));
  assert.equal(live.live, 'assertive'); assert.equal(live.atomic, 'true');
  if (feedback) assert.ok(live.text.includes(feedback));
  const controls = page.locator('a,input,button');
  for (const backwards of [false, true]) {
    const ordered = await controls.all(); if (backwards) ordered.reverse();
    for (const control of ordered) await tabTo(page, control, backwards);
  }
  const directory = '.crabbox/evidence/rc14-browser';
  await mkdir(directory, { recursive: true });
  await page.screenshot({ path: join(directory, name + '.png'), fullPage: true, mask: [page.locator('input'), page.locator('strong')] });
}
