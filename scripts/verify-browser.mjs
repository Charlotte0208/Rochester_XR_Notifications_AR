import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
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
let activePage;

function watch(target) {
  target.on('pageerror', error => errors.push(error.message));
  target.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  target.on('response', response => {
    if (/\/assets\/notification-objects\/.*\.glb$/.test(response.url())) {
      assets.set(path.basename(new URL(response.url()).pathname), response.status());
    }
  });
}

async function state(target, expected, timeout = 10000) {
  await target.waitForFunction(expected => Object.entries(expected).every(([key, value]) =>
    document.body.dataset[key] === value), expected, { timeout });
}

async function capture(name, target = page) {
  const filename = path.join(output, `${name}.png`);
  await target.screenshot({ path: filename, fullPage: true });
  screenshots.push(filename);
}

async function observeDesktopState(target) {
  await target.addInitScript(() => {
    const record = { states: [] };
    window.__browserSmoke = record;
    let last = '';
    new MutationObserver(() => {
      if (!document.body) return;
      const { mode, feature, phase } = document.body.dataset;
      const key = `${mode}|${feature}|${phase}`;
      if (key === last) return;
      last = key;
      record.states.push({ mode, feature, phase, wallTime: performance.now() });
    }).observe(document, { attributes: true, subtree: true, attributeFilter: ['data-mode', 'data-feature', 'data-phase'] });
  });
}

async function inspectIdleScene(target) {
  // Inspect actual scene instances without changing application objects or exporting production hooks.
  const threeUrl = await target.evaluate(() => performance.getEntriesByType('resource')
    .map(entry => entry.name).find(url => /\/\.vite\/deps\/three\.js(?:\?|$)/.test(url)));
  assert.ok(threeUrl, 'The running application must have loaded Three.js');
  const client = await target.context().newCDPSession(target);
  try {
    const prototype = await client.send('Runtime.evaluate', {
      expression: `import(${JSON.stringify(threeUrl)}).then(module => module.Scene.prototype)`, awaitPromise: true,
    });
    const instances = await client.send('Runtime.queryObjects', { prototypeObjectId: prototype.result.objectId });
    const inspected = await client.send('Runtime.callFunctionOn', {
      objectId: instances.objects.objectId, returnByValue: true,
      functionDeclaration: `function() {
        const matches = [];
        for (const scene of this) {
          const demonstration = scene.getObjectByName('AR cue familiarization objects');
          if (!demonstration) continue;
          let fabricatedTables = 0, visibleMeshes = 0;
          scene.traverse(object => {
            if (/desktop preview table|virtual table/i.test(object.name) || object.geometry?.type === 'BoxGeometry') fabricatedTables++;
            if (!object.isMesh) return;
            let visible = true;
            for (let parent = object; parent; parent = parent.parent) visible &&= parent.visible;
            if (visible) visibleMeshes++;
          });
          matches.push({ demonstrationVisible: demonstration.visible, fabricatedTables, visibleMeshes,
            bagLoaded: Boolean(demonstration.getObjectByName('Delivery bag')),
            moonLoaded: Boolean(demonstration.getObjectByName('Focus moon')) });
        }
        return matches;
      }`,
    });
    assert.ok(inspected.result.value?.length > 0, 'The live application scene must be present');
    for (const scene of inspected.result.value) {
      assert.deepEqual(scene, { demonstrationVisible: false, fabricatedTables: 0, visibleMeshes: 0,
        bagLoaded: true, moonLoaded: true }, 'Desktop must not fabricate a table or display AR content');
    }
    return inspected.result.value;
  } finally { await client.detach(); }
}

async function assertDesktopIdle(target) {
  await state(target, { mode: 'landing' });
  assert.equal(await target.locator('#enter-ar').isDisabled(), true);
  assert.deepEqual(await target.evaluate(() => ({ feature: document.body.dataset.feature ?? null,
    phase: document.body.dataset.phase ?? null })), { feature: null, phase: null });
  assert.equal(await target.locator('#preview, #preview-label, #previous, #next, #pause, #replay, #rescan, #stop, #playback').count(), 0);
  const trace = await target.evaluate(() => window.__browserSmoke);
  assert.ok(trace.states.every(entry => !['running', 'complete'].includes(entry.mode)), 'Desktop must never start a feature');
  return trace;
}

try {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 1100 } });
  page = await context.newPage();
  activePage = page;
  watch(page);
  await observeDesktopState(page);
  const response = await page.goto(baseURL);
  assert.equal(response.status(), 200);
  await state(page, { mode: 'landing' }, 30000);
  await page.waitForFunction(() => !/loading|checking/i.test(document.getElementById('enter-ar')?.textContent ?? ''), null, { timeout: 10000 });
  assert.equal(await page.evaluate(() => window.isSecureContext), true);
  assert.equal(await page.locator('#viewport canvas').count(), 1);
  assert.equal(assets.get('uber_eats_delivery_bag.glb'), 200);
  assert.equal(assets.get('apple_focus_moon.glb'), 200);
  assert.deepEqual(await page.locator('button').evaluateAll(buttons => buttons.map(button => button.id)), ['enter-ar']);
  assert.doesNotMatch(await page.locator('body').innerText(), /[\u3400-\u9fff]/);
  await assertDesktopIdle(page);
  checks.push('English entry screen has one AR control and no desktop playback controls');

  const buttonBounds = await page.locator('#enter-ar').boundingBox();
  await page.mouse.click(buttonBounds.x + buttonBounds.width / 2, buttonBounds.y + buttonBounds.height / 2);
  await page.locator('#enter-ar').evaluate(button => button.click());
  for (const key of ['ArrowRight', 'ArrowLeft', 'r', 'Space']) await page.keyboard.press(key);
  await page.waitForTimeout(3500);
  const desktopTrace = await assertDesktopIdle(page);
  const desktopScene = await inspectIdleScene(page);
  await capture('01-landing');
  checks.push('Desktop stays idle beyond three seconds after clicks and former keyboard shortcuts; no virtual table or visible AR meshes');

  const queryPage = await context.newPage();
  activePage = queryPage;
  watch(queryPage);
  await observeDesktopState(queryPage);
  const queryURL = new URL(baseURL);
  queryURL.searchParams.set('preview', '1');
  queryURL.searchParams.set('autoplay', '1');
  await queryPage.goto(queryURL.href);
  await state(queryPage, { mode: 'landing' }, 30000);
  await queryPage.waitForTimeout(3500);
  const queryTrace = await assertDesktopIdle(queryPage);
  const queryScene = await inspectIdleScene(queryPage);
  await queryPage.close();
  activePage = page;
  checks.push('Preview/autoplay query parameters cannot bypass real AR entry or table scanning');

  // Exercise real decoded models at every condition without modifying application state or adding hooks.
  const modelAndAudio = await page.evaluate(async () => {
    const { Demonstration } = await import('/src/familiarization/Demonstration.ts');
    const { DEMONSTRATION_SECONDS } = await import('/src/familiarization/sequence.ts');
    const thirds = DEMONSTRATION_SECONDS / 3;
    const variationTimes = count => Array.from({ length: count }, (_, index) =>
      index === 0 ? 0 : DEMONSTRATION_SECONDS * index / count + 0.1);
    const demo = new Demonstration();
    await demo.load();
    const beforePlacement = demo.render(0, 0);
    const unconfiguredHidden = !demo.group.visible && beforePlacement.objectCount === 0;
    const Vector3 = demo.group.position.constructor;
    demo.setPlacement({ tablePosition: new Vector3(0, 0.75, -1.25), viewerPosition: new Vector3(0, 1.6, 0),
      forward: new Vector3(0, 0, -1), tablePolygon: [new Vector3(-0.8, 0.75, -0.75),
        new Vector3(0.8, 0.75, -0.75), new Vector3(0.8, 0.75, -1.75), new Vector3(-0.8, 0.75, -1.75)] });
    function bounds(model) {
      model.updateMatrixWorld(true);
      let box;
      model.traverse(object => {
        if (!object.isMesh || !object.geometry) return;
        object.geometry.computeBoundingBox();
        const transformed = object.geometry.boundingBox.clone().applyMatrix4(object.matrixWorld);
        if (box) box.union(transformed); else box = transformed;
      });
      return { name: model.name, min: box.min.toArray(), max: box.max.toArray() };
    }
    const results = [];
    for (const [feature, times] of [[0, [0]], [1, variationTimes(3)], [2, variationTimes(3)],
      [3, variationTimes(4)], [4, [0, thirds - 0.2, thirds + 0.1, thirds * 2 - 0.2, thirds * 2 + 0.1]]]) {
      for (const time of times) {
        const result = demo.render(feature, time);
        const bag = demo.group.getObjectByName('Delivery bag');
        const visibleModels = demo.group.children.filter(child => child.visible && ['Delivery bag', 'Focus moon'].includes(child.name));
        results.push({ feature, time, ...result,
          visible: visibleModels.map(child => child.name), bounds: visibleModels.map(bounds),
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
      for (const time of [0, 0.1, thirds + 0.1, thirds + 0.2, thirds + 2.1,
        ...Array.from({length: 7}, (_, i) => thirds * 2 + i * 0.75 + 0.02)]) {
        demo.render(4, time);
        audio.push({ time, scheduledOscillators });
      }
      demo.stopAudio();
      demo.render(4, thirds * 2 + 4.6);
      audio.push({ time: thirds * 2 + 4.6, scheduledOscillators });
      const runningAudio = contexts[0]?.state === 'running';
      return { results, audio, runningAudio, unconfiguredHidden };
    } finally {
      window.AudioContext = NativeAudioContext;
      demo.dispose();
    }
  });
  const { results: modelResults, audio: audioResults } = modelAndAudio;
  assert.equal(modelAndAudio.unconfiguredHidden, true, 'A decoded demonstration must not render before explicit measured placement');
  for (const result of modelResults) {
    const expectedCount = result.feature === 0 ? 2 : result.feature === 4 && [4.8, 9.8].includes(result.time) ? 0 : 1;
    assert.equal(result.objectCount, expectedCount, JSON.stringify(result));
    assert.equal(result.captionVisible, result.feature > 0 && (result.feature === 4 || expectedCount > 0), 'Sound caption stays present through transitions');
    if (result.feature === 4) assert.equal(result.label, ['no sound', 'quick sound', 'repetitive sound'][Math.floor(result.time / 5)]);
    if (result.feature === 0) assert.deepEqual(result.visible, ['Delivery bag', 'Focus moon']);
    else assert.ok(!result.visible.includes('Focus moon'));
  }
  const sizes = modelResults.filter(result => result.feature === 1).map(result => result.scale);
  assert.ok(Math.abs(sizes[1] / sizes[0] - 3.5) < 1e-6);
  assert.ok(Math.abs(sizes[2] / sizes[0] - 8) < 1e-6);
  assert.deepEqual(modelResults.filter(result => result.feature === 1).map(result => result.label), ['Small', 'Medium', 'Large']);
  for (const result of modelResults.filter(result => result.feature !== 3)) {
    assert.ok(Math.abs(result.position[1] - 0.75) < 0.01, `Object left the tabletop: ${JSON.stringify(result)}`);
    assert.doesNotMatch(result.label, /floor/i);
    for (const box of result.bounds) {
      assert.ok(box.min[1] >= 0.749 && box.min[1] < 0.76, `${box.name} does not rest on the table`);
      assert.ok(box.min[0] >= -0.8 && box.max[0] <= 0.8 && box.min[2] >= -1.75 && box.max[2] <= -0.75,
        `${box.name} extends beyond the tabletop`);
    }
  }
  checks.push('Isolated GLBs remain hidden without placement; an explicit test fixture verifies all five features, size ratios and supported geometry');
  assert.equal(modelAndAudio.runningAudio, true);
  assert.deepEqual(audioResults.map(result => result.scheduledOscillators), [0, 0, 2, 2, 2, 4, 6, 8, 10, 12, 14, 16, 16]);
  checks.push('Real Web Audio: silent once without audio, one short chime, then seven faster chimes; captions identify each sound condition');

  const panelChecks = await page.evaluate(async () => {
    const { SpatialPanel } = await import('/src/ui/SpatialPanel.ts');
    const panel = new SpatialPanel();
    const canvas = panel.mesh.material.map.image;
    const context = canvas.getContext('2d');
    const originalFill = context.fillText.bind(context), originalClear = context.clearRect.bind(context);
    let text = [];
    context.clearRect = (...args) => { text = []; return originalClear(...args); };
    context.fillText = (value, x, y, ...args) => { text.push({value, x, y, font: context.font}); return originalFill(value, x, y, ...args); };
    const projection = [1, 0, 0, 0, 0, 1];
    const position = panel.mesh.position.clone(), orientation = panel.mesh.quaternion.clone();
    const cases = [];
    for (const [title, mode] of [['Look at your table', 'status'], ['Complete', 'status'], ['3. Distance and placement', 'title']]) {
      panel.show(title, mode); panel.follow(position, orientation, projection);
      cases.push({title, mode, text, width: canvas.width, height: canvas.height,
        area: panel.mesh.scale.x * panel.mesh.scale.y, png: canvas.toDataURL('image/png')});
    }
    panel.dispose();
    return cases;
  });
  for (const item of panelChecks) {
    assert.equal(new Set(item.text.map(line => line.font)).size, 1, 'No small secondary font');
    assert.ok(item.text.every(line => Math.abs(line.x - item.width / 2) < 1e-6));
    const meanY = item.text.reduce((sum, line) => sum + line.y, 0) / item.text.length;
    assert.ok(Math.abs(meanY - item.height / 2) < 1e-6, 'All panel text is centred');
    assert.equal(item.text.map(line => line.value).join(' '), item.title);
    if (item.mode === 'status') assert.ok(Number(item.text[0].font.match(/([\d.]+)px/)[1]) >= 160);
    else assert.ok(Math.abs(item.area / ((2.8 * 0.8) * (2.8 * 0.5) / 3) - 0.5) < 1e-8);
    const filename = path.join(output, `panel-${item.title === 'Complete' ? 'end' : item.mode === 'title' ? 'category' : 'start'}.png`);
    writeFileSync(filename, Buffer.from(item.png.split(',')[1], 'base64'));
    screenshots.push(filename);
  }
  checks.push('Start/end panels use large centred text only; category panel area is exactly half its previous size');

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
      await ar.end();
      const cleared = ar.session === null && ar.space === null;
      deny = true;
      await ar.enter();
      const retryAvailable = !button.disabled;
      deny = false;
      await ar.enter();
      await ar.end();
      return { supported, running, cleared, retryAvailable, requests, starts, ends, unlocks, referenceType,
        requestModes, messages };
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
  assert.ok(sessionResults.messages.some(message => /Permission denied/i.test(message)));
  checks.push('Mocked XR lifecycle: entry guard, local-space fallback, permission denial feedback and clean exit/re-entry');

  const entryRace = await page.evaluate(async () => {
    const { ARSession } = await import('/src/xr/arSession.ts');
    const original = Object.getOwnPropertyDescriptor(navigator, 'xr');
    const deferred = () => {
      let resolve;
      const promise = new Promise(done => { resolve = done; });
      return { promise, resolve };
    };
    const gates = [deferred(), deferred()];
    const started = [deferred(), deferred()];
    const space = new EventTarget();
    const sessions = [new EventTarget(), new EventTarget()];
    for (const session of sessions) {
      session.requestReferenceSpace = async () => space;
      session.end = async () => session.dispatchEvent(new Event('end'));
    }
    let requests = 0;
    Object.defineProperty(navigator, 'xr', { configurable: true, value: {
      requestSession: async () => sessions[requests++],
    }});
    const button = document.createElement('button');
    const renderer = { xr: { setReferenceSpaceType() {}, setSession: async () => {}, getReferenceSpace: () => space } };
    const ar = new ARSession(renderer, button, {
      onStart: session => { const index = sessions.indexOf(session); started[index].resolve(); return gates[index].promise; },
      onEnd() {}, onStatus() {}, unlockAudio() {},
    });
    try {
      const firstEntry = ar.enter();
      await started[0].promise;
      await sessions[0].end();
      const secondEntry = ar.enter();
      await started[1].promise;
      gates[0].resolve();
      await firstEntry;
      const remainsLocked = button.disabled && ar.session === sessions[1];
      await ar.enter();
      const duplicateRequestPrevented = requests === 2;
      gates[1].resolve();
      await secondEntry;
      const newestEntryCompleted = !button.disabled && ar.session === sessions[1] && ar.floorSpace;
      await ar.end();
      return { remainsLocked, duplicateRequestPrevented, newestEntryCompleted,
        cleanedUp: ar.session === null && ar.space === null && !ar.floorSpace };
    } finally {
      gates.forEach(gate => gate.resolve());
      if (original) Object.defineProperty(navigator, 'xr', original);
      else delete navigator.xr;
    }
  });
  assert.deepEqual(entryRace, { remainsLocked: true, duplicateRequestPrevented: true, newestEntryCompleted: true, cleanedUp: true });
  checks.push('XR entry race: completing an ended session cannot unlock or replace a newer pending entry');

  await assertDesktopIdle(page);

  const mobile = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 }, isMobile: true });
  const mobilePage = await mobile.newPage();
  activePage = mobilePage;
  watch(mobilePage);
  await observeDesktopState(mobilePage);
  await mobilePage.goto(baseURL);
  await state(mobilePage, { mode: 'landing' }, 30000);
  await assertDesktopIdle(mobilePage);
  const mobileLayout = await mobilePage.evaluate(() => ({ viewport: innerWidth, width: document.documentElement.scrollWidth }));
  assert.ok(mobileLayout.width <= mobileLayout.viewport + 1, JSON.stringify(mobileLayout));
  await capture('mobile-landing', mobilePage);
  checks.push('390px mobile entry has no playback bypass or horizontal document overflow');
  await mobile.close();

  assert.deepEqual(errors, [], 'Browser page/console errors');
  checks.push('No browser page errors or console errors');
  const report = { baseURL, browser: await browser.version(), checks, assets: Object.fromEntries(assets),
    desktopScene, desktopTrace, queryScene, queryTrace, unconfiguredHidden: modelAndAudio.unconfiguredHidden,
    modelResults, audioResults, sessionResults, entryRace, mobileLayout, errors, screenshots,
    boundary: 'Desktop entry gating and isolated model/audio/session tests only. Real Quest passthrough, recognized table input and the full headset playback require on-device acceptance; no desktop playback substitute exists.' };
  writeFileSync(path.join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  for (const filename of ['failure.png', 'failure.json']) {
    const file = path.join(output, filename);
    if (existsSync(file)) unlinkSync(file);
  }
  console.log(JSON.stringify({ passed: checks.length, checks, output, screenshots }, null, 2));
} catch (error) {
  let currentState;
  if (activePage && !activePage.isClosed()) {
    await activePage.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
    currentState = await activePage.evaluate(() => ({ state: { ...document.body.dataset }, trace: window.__browserSmoke })).catch(() => null);
  }
  writeFileSync(path.join(output, 'failure.json'), JSON.stringify({ message: String(error), errors, checks, currentState }, null, 2));
  throw error;
} finally {
  await browser.close();
}
