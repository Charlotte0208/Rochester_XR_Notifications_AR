import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Run against an already running Vite server: npm run dev, then npm run test:browser.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, '.codex-run', 'browser');
const baseURL = process.argv[2] || process.env.AR_TEST_URL || 'https://localhost:5182/';
mkdirSync(output, { recursive: true });

async function loadPlaywright() {
  try { return await import('playwright'); }
  catch {
    const bundled = process.env.PLAYWRIGHT_MODULE_PATH || path.join(os.homedir(), '.cache', 'codex-runtimes',
      'codex-primary-runtime', 'dependencies', 'node', 'node_modules', 'playwright', 'index.mjs');
    if (!existsSync(bundled)) throw new Error('Install playwright or set PLAYWRIGHT_MODULE_PATH to its index.mjs.');
    return import(pathToFileURL(bundled).href);
  }
}

function browserExecutable(chromium) {
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH) return process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  if (existsSync(chromium.executablePath())) return chromium.executablePath();
  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(os.homedir(), 'AppData', 'Local', 'ms-playwright');
  if (process.platform === 'win32' && existsSync(cache)) {
    for (const folder of readdirSync(cache).filter(name => /^chromium-\d+$/.test(name)).sort().reverse()) {
      const executable = path.join(cache, folder, 'chrome-win64', 'chrome.exe');
      if (existsSync(executable)) return executable;
    }
  }
  return chromium.executablePath();
}

const { chromium } = await loadPlaywright();
const browser = await chromium.launch({ headless: true, executablePath: browserExecutable(chromium),
  args: ['--enable-unsafe-swiftshader'] });
const errors = [];
const assets = new Map();
const checks = [];
const screenshots = [];
let page;

function watch(target) {
  target.on('pageerror', error => errors.push(error.message));
  target.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  target.on('response', response => {
    if (/\/assets\/notification-objects\/.*\.glb$/.test(response.url())) {
      assets.set(path.basename(new URL(response.url()).pathname), response.status());
    }
  });
}

async function state(text, timeout = 10000) {
  await page.waitForFunction(expected => document.getElementById('stage-state')?.textContent === expected, text, { timeout });
}

async function capture(name, target = page, canvasOnly = false) {
  const filename = path.join(output, `${name}.png`);
  if (canvasOnly) await target.locator('.stage').screenshot({ path: filename });
  else await target.screenshot({ path: filename, fullPage: true });
  screenshots.push(filename);
}

try {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 1100 } });
  page = await context.newPage();
  watch(page);
  const response = await page.goto(baseURL);
  assert.equal(response.status(), 200);
  await page.waitForFunction(() => !document.getElementById('preview')?.disabled, null, { timeout: 30000 });
  await state('Drag to explore');
  assert.equal(await page.evaluate(() => window.isSecureContext), true);
  assert.equal(await page.locator('#viewport canvas').count(), 1);
  assert.equal(assets.get('uber_eats_delivery_bag.glb'), 200);
  assert.equal(assets.get('apple_focus_moon.glb'), 200);
  await capture('01-landing');
  checks.push('HTTPS landing: both supplied GLBs decoded, WebGL canvas ready');

  const introducedAt = Date.now();
  await page.locator('#preview').click();
  await state('1 / 5 · Introduction');
  await capture('02-title-two-types', page, true);
  await state('1 / 5 · Demonstration');
  const introDurationMs = Date.now() - introducedAt;
  assert.ok(introDurationMs >= 2800, `Title ended too soon: ${introDurationMs}ms`);
  assert.equal(await page.locator('#variation').textContent(), 'Delivery bag and focus moon');
  await capture('03-demo-two-types', page, true);
  checks.push(`First title remained visible for three seconds (${introDurationMs}ms including browser operations)`);

  await page.locator('#pause').click();
  await state('Paused');
  const pausedClock = await page.locator('#clock').textContent();
  await page.waitForTimeout(1200);
  assert.equal(await page.locator('#clock').textContent(), pausedClock, 'Pause must freeze the timeline');
  assert.equal(await page.locator('#pause').textContent(), 'Resume');
  await page.locator('#pause').click();
  await state('1 / 5 · Demonstration');
  await page.locator('#replay').click();
  await state('1 / 5 · Introduction');
  checks.push('Pause freezes time; resume and replay restore the correct phase');

  const firstVariations = ['Small · 14 cm (longest side)', /^Near ·/, 'Still', 'Silent'];
  for (let index = 1; index < 5; index++) {
    await page.locator('#next').click();
    await state(`${index + 1} / 5 · Introduction`);
    assert.equal(await page.locator(`li[data-feature="${index}"]`).getAttribute('class'), 'active');
    await capture(`0${index + 3}-title-feature-${index + 1}`, page, true);
    await state(`${index + 1} / 5 · Demonstration`);
    const variation = await page.locator('#variation').textContent();
    if (firstVariations[index - 1] instanceof RegExp) assert.match(variation, firstVariations[index - 1]);
    else assert.equal(variation, firstVariations[index - 1]);
    await capture(`demo-feature-${index + 1}`, page, true);
  }
  await page.locator('#previous').click();
  await state('4 / 5 · Introduction');
  await page.locator('#replay').click();
  await state('4 / 5 · Introduction');
  await page.locator('#next').click();
  await state('5 / 5 · Introduction');
  await page.locator('#next').click();
  await state('5 / 5 · Introduction');
  checks.push('All five features: title then demonstration; Previous/Next/Replay and final-index bounds');

  // Exercise real decoded models at every condition without modifying application state or adding hooks.
  const modelAndAudio = await page.evaluate(async () => {
    const { Demonstration } = await import('/src/familiarization/Demonstration.ts');
    const demo = new Demonstration();
    await demo.load();
    const results = [];
    for (const [feature, times] of [[0, [0]], [1, [0, 19.1, 38.1]], [2, [0, 11.5, 22.9, 34.3, 45.7]],
      [3, [0, 14.3, 28.6, 42.9]], [4, [0, 6.5, 7.6, 19.1, 38.1]]]) {
      for (const time of times) {
        const result = demo.render(feature, time);
        const bag = demo.group.getObjectByName('Delivery bag');
        results.push({ feature, time, ...result,
          visible: demo.group.children.filter(child => child.visible && ['Delivery bag', 'Focus moon'].includes(child.name)).map(child => child.name),
          captionVisible: demo.group.getObjectByName('Current variation caption')?.visible ?? false,
          scale: bag.scale.x, position: bag.position.toArray() });
      }
    }
    // Count real oscillator scheduling in an isolated demonstration instance.
    // This checks Web Audio behavior; it does not claim that headset audio was heard.
    const NativeAudioContext = window.AudioContext;
    const contexts = [];
    let scheduledOscillators = 0;
    window.AudioContext = class extends NativeAudioContext {
      constructor(...args) { super(...args); contexts.push(this); }
      createOscillator() {
        const oscillator = super.createOscillator();
        const start = oscillator.start.bind(oscillator);
        oscillator.start = (...args) => { scheduledOscillators++; return start(...args); };
        return oscillator;
      }
    };
    const audio = [];
    try {
      await demo.unlockAudio();
      demo.hide();
      for (const time of [0, 0.1, 19.1, 19.2, 26.7, 38.1, 45.7]) {
        demo.render(4, time);
        audio.push({ time, scheduledOscillators });
      }
      demo.stopAudio();
      demo.render(4, 45.8);
      audio.push({ time: 45.8, scheduledOscillators });
      const runningAudio = contexts[0]?.state === 'running';
      return { results, audio, runningAudio };
    } finally {
      window.AudioContext = NativeAudioContext;
      demo.dispose();
    }
  });
  const { results: modelResults, audio: audioResults } = modelAndAudio;
  for (const result of modelResults) {
    const expectedCount = result.feature === 0 ? 2 : result.feature === 4 && result.time === 6.5 ? 0 : 1;
    assert.equal(result.objectCount, expectedCount, JSON.stringify(result));
    assert.equal(result.captionVisible, result.feature > 0 && expectedCount > 0, 'The caption follows the single object visibility');
    if (result.feature === 0) assert.deepEqual(result.visible, ['Delivery bag', 'Focus moon']);
    else assert.ok(!result.visible.includes('Focus moon'));
  }
  assert.deepEqual(modelResults.filter(result => result.feature === 1).map(result => result.scale), [0.14, 0.28, 0.48]);
  checks.push('Real GLB rendering: 2 objects only in feature 1; all size/distance/motion/sound variations and disappearance');
  assert.equal(modelAndAudio.runningAudio, true);
  assert.deepEqual(audioResults.map(result => result.scheduledOscillators), [0, 0, 2, 2, 2, 4, 6, 6]);
  checks.push('Real Web Audio: silent condition schedules nothing, single chime plays once, repeated chimes follow reappearance, stop/resume does not duplicate a cue');

  const sessionResults = await page.evaluate(async () => {
    const { ARSession } = await import('/src/xr/arSession.ts');
    const original = Object.getOwnPropertyDescriptor(navigator, 'xr');
    let requests = 0, starts = 0, ends = 0, unlocks = 0, referenceType = '', deny = false;
    const messages = [], requestModes = [];
    const space = new EventTarget();
    const session = new EventTarget();
    session.requestReferenceSpace = async type => { if (type === 'local-floor') throw new Error('No floor reference'); return space; };
    session.end = async () => session.dispatchEvent(new Event('end'));
    const renderer = { xr: { setReferenceSpaceType: type => { referenceType = type; }, setSession: async () => {}, getReferenceSpace: () => space } };
    Object.defineProperty(navigator, 'xr', { configurable: true, value: {
      isSessionSupported: async mode => mode === 'immersive-ar',
      requestSession: async mode => { requests++; requestModes.push(mode); if (deny) throw new Error('Permission denied'); return session; }
    }});
    try {
      const button = document.createElement('button');
      const ar = new ARSession(renderer, button, { onStart: async () => { starts++; }, onEnd: () => { ends++; },
        onStatus: message => messages.push(message), unlockAudio: () => { unlocks++; } });
      await ar.check();
      const supported = !button.disabled;
      await Promise.all([ar.enter(), ar.enter()]);
      const running = ar.session === session && ar.space === space;
      let captureMessage = '';
      try { await ar.captureRoom(); } catch (error) { captureMessage = error.message; }
      await ar.end();
      const cleared = ar.session === null && ar.space === null;
      deny = true;
      await ar.enter();
      const retryAvailable = !button.disabled && button.textContent === 'Try entering AR again';
      deny = false;
      await ar.enter();
      await ar.end();
      return { supported, running, cleared, retryAvailable, requests, starts, ends, unlocks, referenceType,
        requestModes, captureMessage, messages };
    } finally {
      if (original) Object.defineProperty(navigator, 'xr', original);
      else delete navigator.xr;
    }
  });
  assert.equal(sessionResults.supported, true);
  assert.equal(sessionResults.running, true);
  assert.equal(sessionResults.cleared, true);
  assert.equal(sessionResults.retryAvailable, true);
  assert.equal(sessionResults.requests, 3);
  assert.equal(sessionResults.starts, 2);
  assert.equal(sessionResults.ends, 2);
  assert.equal(sessionResults.unlocks, 3);
  assert.equal(sessionResults.referenceType, 'local');
  assert.deepEqual(sessionResults.requestModes, ['immersive-ar', 'immersive-ar', 'immersive-ar']);
  assert.match(sessionResults.captureMessage, /Space Setup/);
  checks.push('Mocked XR lifecycle: concurrent entry guard, local-space fallback, denied permission retry, exit/reentry and unavailable capture guidance');

  await page.locator('#stop').click();
  await state('Drag to explore');
  assert.equal(await page.locator('#playback').isVisible(), false);
  assert.equal(await page.locator('#clock').textContent(), '05:00');
  await page.locator('#preview').click();
  await state('1 / 5 · Introduction');
  await page.locator('#stop').click();
  await state('Drag to explore');
  checks.push('Stop returns to landing and a fresh preview starts at feature 1');

  const mobile = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 }, isMobile: true });
  const mobilePage = await mobile.newPage();
  watch(mobilePage);
  await mobilePage.goto(baseURL);
  await mobilePage.waitForFunction(() => !document.getElementById('preview')?.disabled, null, { timeout: 30000 });
  const mobileLayout = await mobilePage.evaluate(() => ({ viewport: innerWidth, width: document.documentElement.scrollWidth }));
  assert.ok(mobileLayout.width <= mobileLayout.viewport + 1, JSON.stringify(mobileLayout));
  await capture('mobile-landing', mobilePage);
  await mobilePage.locator('#preview').click();
  await capture('mobile-title', mobilePage);
  checks.push('390px mobile layout has no horizontal document overflow');
  await mobile.close();

  assert.deepEqual(errors, [], 'Browser page/console errors');
  checks.push('No browser page errors or console errors');
  const report = { baseURL, browser: await browser.version(), checks, assets: Object.fromEntries(assets),
    introDurationMs, modelResults, audioResults, sessionResults, mobileLayout, errors, screenshots,
    boundary: 'Desktop Chromium and mocked XR only. Physical Quest passthrough, room permissions, surface tracking, visual comfort and audible headset output still require on-device acceptance.' };
  writeFileSync(path.join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ passed: checks.length, checks, output, screenshots }, null, 2));
} catch (error) {
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
  writeFileSync(path.join(output, 'failure.json'), JSON.stringify({ message: String(error), errors, checks }, null, 2));
  throw error;
} finally {
  await browser.close();
}
