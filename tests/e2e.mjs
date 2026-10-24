// End-to-end test for the prototype. Drives index.html in headless Edge or Chrome
// over the DevTools protocol — no npm packages needed (Node 22+).
//
//   node tests/e2e.mjs            run all checks
//   node tests/e2e.mjs --shots    also save screenshots to tests/output/
//   node tests/e2e.mjs https://nsteinyale.github.io/hotel-marcel-ride-redesign/   test the live site
//
// Set BROWSER=/path/to/chrome-or-edge if yours isn't found automatically.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const urlArg = process.argv.find(a => /^https?:\/\//.test(a));
const page = urlArg || pathToFileURL(path.join(here, '..', 'index.html')).href;
const outDir = path.join(here, 'output');
const saveShots = process.argv.includes('--shots');

const candidates = [
  process.env.BROWSER,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge',
].filter(Boolean);
const browserPath = candidates.find(p => fs.existsSync(p));
if (!browserPath) { console.error('No Chrome or Edge found. Set BROWSER=/path/to/browser.'); process.exit(2); }

const sleep = ms => new Promise(r => setTimeout(r, ms));
const port = 9300 + Math.floor(Math.random() * 500);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'marcel-e2e-'));
const browser = spawn(browserPath, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });

let ws, id = 0;
const pending = new Map(), pageErrors = [];
const send = (method, params = {}) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
async function ev(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result.exceptionDetails) throw new Error(`page error in: ${expr}\n${r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text}`);
  return r.result.result.value;
}
const q = sel => JSON.stringify(sel);
const click = sel => ev(`(() => { const el = document.querySelector(${q(sel)}); if (!el) throw new Error('not found: ' + ${q(sel)}); el.click(); })()`);
const text = sel => ev(`document.querySelector(${q(sel)})?.innerText ?? null`);
const exists = sel => ev(`!!document.querySelector(${q(sel)})`);
const setSelect = (sel, v) => ev(`(() => { const s = document.querySelector(${q(sel)}); s.value = ${q(v)}; s.dispatchEvent(new Event('change', {bubbles:true})); })()`);
const type = (sel, v) => ev(`(() => { const i = document.querySelector(${q(sel)}); i.value = ${q(v)}; i.dispatchEvent(new Event('input', {bubbles:true})); })()`);
const submit = sel => ev(`document.querySelector(${q(sel)}).form.requestSubmit()`);
async function waitFor(sel, ms = 60000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await exists(sel)) return; await sleep(250); }
  throw new Error(`timed out waiting for ${sel}`);
}
let shot = 0;
async function snap(name) {
  if (!saveShots) return;
  fs.mkdirSync(outDir, { recursive: true });
  const r = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(outDir, `${String(++shot).padStart(2, '0')}-${name}.png`), Buffer.from(r.result.data, 'base64'));
}
async function load(width = 1000, height = 900, mobile = false) {
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: mobile ? 2 : 1, mobile });
  await send('Page.navigate', { url: page });
  await sleep(1200);
}

// --- tiny test runner ---
const results = [];
async function test(name, fn) {
  const t0 = Date.now();
  try { await fn(); results.push([true, name]); console.log(`  ✓ ${name} (${((Date.now() - t0) / 1000).toFixed(1)}s)`); }
  catch (e) { results.push([false, name]); console.log(`  ✗ ${name}\n      ${e.message.split('\n').join('\n      ')}`); }
}
function expect(cond, msg) { if (!cond) throw new Error(msg); }

try {
  let targets;
  for (let i = 0; i < 60 && !targets; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); } catch { await sleep(250); } }
  ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
  await new Promise(r => ws.onopen = r);
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    if (m.method === 'Runtime.exceptionThrown') pageErrors.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
  };
  await send('Runtime.enable'); await send('Page.enable');
  console.log(`Testing ${page}\nwith ${browserPath}\n`);

  // ---------------- Ride now: full trip ----------------
  await load();
  await snap('start');

  await test('guest can request a ride now', async () => {
    expect(await exists('#guest [data-act=request][disabled]'), 'Request button should be disabled before a destination is chosen');
    await setSelect('#guest [data-model=dropoff]', 'som');
    await click('#guest [data-act=request]');
    expect(await text('#guest h2') === 'Finding your driver', `guest title was "${await text('#guest h2')}"`);
    expect(await exists('#driver [data-act=accept]'), 'driver queue should show an Accept button');
  });

  await test('message button is locked until a driver accepts', async () => {
    expect(await exists('#guest .act[data-act=openChat][disabled]'), 'guest Message button should be disabled');
  });

  await test('driver accepts and the car makes progress toward pickup', async () => {
    await click('#driver [data-act=accept]');
    expect((await text('#guest h2')).includes('on the way'), `guest title was "${await text('#guest h2')}"`);
    const w1 = await ev(`parseFloat(document.querySelector('#guest [data-i="1"]').style.width)`);
    await sleep(1500);
    const w2 = await ev(`parseFloat(document.querySelector('#guest [data-i="1"]').style.width)`);
    expect(w2 > w1, `progress bar should grow (was ${w1}% then ${w2}%)`);
    expect(/Pickup in \d+ min/.test(await text('#guest .map-chip')), `map chip was "${await text('#guest .map-chip')}"`);
    await snap('en-route');
  });

  await test('driver never sees the guest room number', async () => {
    const driverText = await ev(`document.querySelector('#driver').innerText`);
    expect(!/\b412\b|Room|Rm /.test(driverText), 'driver screen mentions the room');
    expect(driverText.includes('Jordan L.'), 'driver should see first name + last initial');
  });

  await test('guest → driver message shows an alert and unread badge', async () => {
    await click('#guest .act[data-act=openChat]');
    await type('#guest [data-draft=guest]', 'I have a big suitcase, is that ok?');
    await submit('#guest [data-draft=guest]');
    expect((await text('#driver .toast')).includes('big suitcase'), 'driver should get a message alert');
    expect(await text('#driver .act .badge') === '1', 'driver Message button should show 1 unread');
  });

  await test('driver replies; guest sees typing indicator and both messages', async () => {
    await click('#driver .act[data-act=openChat]');
    expect(!(await exists('#driver .act .badge')), 'unread badge should clear once chat is opened');
    await click('#driver [data-act=quick][data-text^="On my way"]');
    await type('#driver [data-draft=driver]', 'Yes, plenty of room!');
    expect((await text('#guest .typing')) === 'Marcus is typing…', 'guest should see the typing indicator');
    await submit('#driver [data-draft=driver]');
    const bubbles = await ev(`[...document.querySelectorAll('#guest .bub')].map(b => b.firstChild.textContent)`);
    expect(JSON.stringify(bubbles) === JSON.stringify(['I have a big suitcase, is that ok?', 'On my way!', 'Yes, plenty of room!']), `guest chat was ${JSON.stringify(bubbles)}`);
    await snap('chat');
  });

  await test('chat text is shown as plain text, never as HTML', async () => {
    await type('#guest [data-draft=guest]', '<img src=x onerror="window.__pwned=1"><b>bold</b>');
    await submit('#guest [data-draft=guest]');
    await sleep(200);
    expect(!(await exists('#driver .bub img')) && !(await exists('#driver .bub b')), 'HTML in a message was rendered');
    expect(!(await ev('window.__pwned')), 'script in a message ran');
  });

  await test('car arrives at pickup; guest is told', async () => {
    await click('#guest [data-act=closeChat]'); await click('#driver [data-act=closeChat]');
    await waitFor('#driver [data-act=pickedUp]');
    expect(await text('#guest h2') === 'Your driver has arrived', `guest title was "${await text('#guest h2')}"`);
  });

  await test('trip to destination shows progress and countdown', async () => {
    await click('#driver [data-act=pickedUp]');
    await sleep(1500);
    expect(await text('#guest h2') === 'Heading to Yale SOM', `guest title was "${await text('#guest h2')}"`);
    expect(await ev(`parseFloat(document.querySelector('#guest [data-i="3"]').style.width)`) > 0, 'on-trip progress should start filling');
    expect(/min to Yale SOM/.test(await text('#guest .map-chip')), `map chip was "${await text('#guest .map-chip')}"`);
    await snap('on-trip');
  });

  await test('driver completes the ride; guest can rate', async () => {
    await waitFor('#driver .btn.pulse');
    await click('#driver [data-act=complete]');
    expect(await text('#guest h2') === 'Ride Complete', 'guest should see Ride Complete');
    await click('#guest [data-act=rate][data-v="5"]');
    expect(await ev(`document.querySelectorAll('#guest .stars .on').length`) === 5, 'five stars should be lit');
  });

  await test('Grazzy tip: optional, opens the driver link, sends no personal data', async () => {
    await click('#guest [data-act=tip]');
    expect(await exists('#guest .tipsheet'), 'tip sheet should open');
    const sheet = await text('#guest .tipsheet');
    expect(/complimentary/i.test(sheet) && /optional/i.test(sheet), 'sheet should say the ride is free and the tip optional');
    const a = await ev(`(() => { const a = document.querySelector('#guest .tipsheet a'); return {href: a.href, target: a.target, rel: a.rel}; })()`);
    expect(/grazzy\.com/.test(a.href), `tip link was ${a.href}`);
    expect(!/jordan|412|som|phone/i.test(a.href), `tip link leaks personal data: ${a.href}`);
    expect(a.target === '_blank' && a.rel.includes('noopener'), 'tip link should open safely in a new tab');
    await snap('tip');
    await ev(`document.querySelector('#guest .tipsheet a').addEventListener('click', e => e.preventDefault())`);
    await click('#guest .tipsheet a');
    await sleep(100);
    expect((await text('#guest .tipbtn')).includes('opened'), 'tip button should note the page was opened');
    expect(!(await ev(`/tip/i.test(document.querySelector('#driver .toast')?.innerText ?? '')`)), 'driver should not be told about tipping');
    await click('#guest [data-act=doneRide]');
  });

  // ---------------- Scheduling ----------------
  await test('guest schedules a ride two days out', async () => {
    await click('#guest [data-act=mode][data-v=later]');
    await click('#guest [data-act=day][data-v="2"]');
    await setSelect('#guest [data-model=dropoff]', 'wooster');
    await setSelect('#guest [data-model=time]', '19:30');
    expect(/7:30 PM/.test(await text('#guest .when-summary')), 'summary should show 7:30 PM');
    await click('#guest [data-act=request]');
    const tags = await ev(`[...document.querySelectorAll('#guest .tag')].map(t => t.textContent)`);
    expect(tags.filter(t => t === 'Awaiting driver').length === 2, `My rides tags were ${JSON.stringify(tags)}`);
  });

  await test('driver confirms a scheduled ride; guest sees Confirmed and can message', async () => {
    await click('#driver [data-act=dtab][data-v=sched]');
    await click('#driver [data-act=acceptLater]');
    expect((await ev(`[...document.querySelectorAll('#guest .tag')].map(t => t.textContent)`)).includes('Confirmed'), 'guest should see Confirmed');
    expect(await exists('#guest .card [data-act=openChat]'), 'confirmed ride should offer Message');
    await snap('scheduled');
  });

  await test('guest changes the time; driver is alerted', async () => {
    await click('#guest [data-act=edit]');
    await setSelect('#guest [data-model=time]', '09:00');
    await click('#guest [data-act=saveEdit]');
    expect((await text('#guest .card b')).includes('9:00 AM'), 'card should show the new time');
    expect((await text('#driver .toast')).includes('9:00 AM'), 'driver should be alerted to the new time');
  });

  await test('guest cancels a scheduled ride with a two-tap confirm', async () => {
    // Cancel the booking still awaiting a driver; keep the confirmed one for the next test.
    const before = await ev(`document.querySelectorAll('#guest .tag').length`);
    const btn = `[...document.querySelectorAll('#guest .card')].find(c => c.querySelector('.tag.amber')).querySelector('[data-act=cancelRide]')`;
    await ev(`${btn}.click()`);
    expect(await ev(`${btn}.innerText`) === 'Tap to confirm', 'first tap should ask to confirm');
    await ev(`${btn}.click()`);
    const tags = await ev(`[...document.querySelectorAll('#guest .tag')].map(t => t.textContent)`);
    expect(tags.includes('Cancelled') && tags.length === before, `tags after cancel: ${JSON.stringify(tags)}`);
  });

  await test('driver can start a confirmed ride when it is time', async () => {
    await click('#driver [data-act=dtab][data-v=sched]');
    await click('#driver [data-act=startNow]');
    await click('#guest [data-act=gtab][data-v=ride]');
    expect((await text('#guest h2')).includes('on the way'), `guest title was "${await text('#guest h2')}"`);
  });

  // ---------------- Phone layout ----------------
  await test('phone-sized screen shows one app with a Guest/Driver switch', async () => {
    await load(390, 844, true);
    expect(await ev(`document.querySelector('#stage').dataset.view`) === 'guest', 'should start on the guest view');
    expect(await ev(`getComputedStyle(document.querySelector('.phone.driver')).display`) === 'none', 'driver phone should be hidden');
    await click('#viewsw [data-view=driver]');
    expect(await ev(`getComputedStyle(document.querySelector('.phone.driver')).display`) !== 'none', 'switch should show the driver');
    await snap('mobile');
  });

  await test('no JavaScript errors on the page', async () => {
    expect(pageErrors.length === 0, pageErrors.join('\n'));
  });
} finally {
  try { ws?.close(); } catch {}
  browser.kill();
  await sleep(300);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
}

const failed = results.filter(r => !r[0]).length;
console.log(`\n${results.length - failed} passed, ${failed} failed${saveShots ? ` · screenshots in ${outDir}` : ''}`);
process.exit(failed ? 1 : 0);
