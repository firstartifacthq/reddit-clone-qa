import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fixture, signup, password } from '../../../tools/rc14-fixture.js';
import { launchBrowser, browserMetadata, geometry } from '../../../tools/rc14-browser.js';
import { candidateDigest } from '../../../tools/rc14-load.js';
const sleep = ms => new Promise(r=>setTimeout(r,ms));
const out = process.env.EVIDENCE;
const report = {candidate: candidateDigest(), startedAt: new Date().toISOString(), facility: browserMetadata, events: []};
function event(kind, detail={}) { report.events.push({kind, at: Date.now(), ...detail}); writeFileSync(out+'/report.json',JSON.stringify(report,null,2)); }
function x(...args) { return execFileSync('/usr/bin/xdotool',args,{encoding:'utf8'}).trim(); }
async function key(chord) { x('key','--clearmodifiers',chord); await sleep(350); }
async function type(text) { x('type','--clearmodifiers','--delay','50',text); await sleep(350); }
const probe = await launchBrowser(); await probe.close();
const require = createRequire(browserMetadata.modulePath+'/package.json');
const f = await fixture();
let browser;
try {
 await signup(f.request,'native_observer');
 browser = await require(browserMetadata.modulePath).chromium.launch({headless:false,args:['--force-renderer-accessibility','--window-size=1280,1000','--no-sandbox']});
 assert.equal(browser.version(),browserMetadata.chromium);
 const context = await browser.newContext({viewport:null}); const page = await context.newPage();
 await page.goto(f.origin); await sleep(3000);
 const windows=x('search','--onlyvisible','--name','Reddit clone').split('\n'); assert.ok(windows.length); x('windowfocus','--sync',windows.at(-1));
 async function tabTo(selector, backwards=false) {
  for(let i=0;i<25;i++) {
   if(await page.locator(selector).evaluate(e=>e===document.activeElement)) {
    await sleep(1200);
    const focus=await page.locator(selector).evaluate(e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return {top:r.top,bottom:r.bottom,viewportHeight:innerHeight,scrollY,label:e.textContent||e.labels?.[0]?.textContent,outline:s.outlineStyle,width:parseFloat(s.outlineWidth),visible:r.top>=-1&&r.bottom<=innerHeight+1,hit:document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)===e};});
    event('focus-geometry',{selector,...focus});
    if(!focus.visible||!focus.hit) await page.screenshot({path:out+'/focus-failure.png',mask:[page.locator('input')]});
    assert.equal(focus.visible,true); assert.equal(focus.hit,true); assert.equal(focus.outline,'solid'); assert.ok(focus.width>=2); event('native-focus',{selector,backwards,...focus}); await sleep(1400); return;
   }
   await key(backwards?'shift+Tab':'Tab');
  }
  assert.fail('native keyboard cannot reach '+selector);
 }
 async function journey(label) {
  await tabTo('nav a:first-child'); await tabTo('#signup-username'); await tabTo('#signup-secret'); await tabTo('#signup-form button');
  await tabTo('#login-username'); await type('native_observer'); await tabTo('#login-secret'); await type('wrong-native-passphrase'); await tabTo('#login-form button');
  event('submit-rejection',{label}); await key('Return');
  await page.waitForFunction(()=>document.querySelector('#auth-message').textContent.startsWith('Unable to sign in.'));
  assert.equal(await page.locator('#login-form button').evaluate(e=>e===document.activeElement),true);
  event('failure-visible-focus-retained',{label,message:await page.locator('#auth-message').textContent()});
  await sleep(13000);
  assert.equal(await page.locator('#login-form button').evaluate(e=>e===document.activeElement),true); event('failure-observation-ended',{label});
  await geometry(page); await page.screenshot({path:out+'/'+label+'-rejection.png',fullPage:true,mask:[page.locator('input')]});
  await tabTo('#login-secret',true); await key('ctrl+a'); await type(password); await tabTo('#login-form button');
  await key('Return'); await page.locator('#logout-form').waitFor(); await sleep(2000);
  assert.equal((await context.request.get(f.origin+'/api/me')).status(),200);
  const cookies=await context.cookies(); const cookie=cookies.map(c=>c.name+'='+c.value).join(';'); event('authenticated',{label,status:200});
  await tabTo('nav a:first-child'); await tabTo('nav a:nth-child(2)'); await tabTo('#logout-form button'); await geometry(page);
  await page.screenshot({path:out+'/'+label+'-authenticated.png',fullPage:true,mask:[page.locator('strong')]});
  await key('Return'); await page.locator('#login-form').waitFor();
  assert.equal((await context.request.get(f.origin+'/api/me')).status(),401);
  assert.equal((await f.request('/api/me','GET',undefined,cookie)).status,401);
  event('logout-revoked',{label,currentStatus:401,replayedStatus:401});
 }
 await journey('normal');
 await key('ctrl+0'); for(let i=0;i<5;i++) await key('ctrl+plus'); await sleep(1500);
 const zoom=await page.evaluate(()=>({devicePixelRatio,innerWidth,root:parseFloat(getComputedStyle(document.documentElement).fontSize)}));
 event('native-zoom',zoom); assert.equal(zoom.devicePixelRatio,2); assert.equal(zoom.root,16);
 await journey('zoom200');
 report.journeysPassed=true; event('finished');
} catch(error) {event('failure',{message:error.message});throw error;}
finally {await browser?.close();await f.close();}
