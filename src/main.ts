import "./styles.css";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { ARSession } from "./xr/arSession";
import { RoomScanner, type RoomSnapshot } from "./xr/RoomScanner";
import { SpatialPanel } from "./ui/SpatialPanel";
import { Demonstration } from "./familiarization/Demonstration";
import { FEATURE_NAMES, TOTAL_SECONDS, FEATURE_SECONDS, getTimelineState } from "./familiarization/sequence";

const app = document.querySelector<HTMLDivElement>("#app")!;
app.innerHTML = `
  <main class="shell">
    <header><a class="brand" href="/" aria-label="AR Familiarization home"><span class="brand-mark">◈</span> Rochester <b>XR</b></a><span class="device">META QUEST 3 <i></i> PASSTHROUGH</span></header>
    <section class="intro"><p class="eyebrow">AR CUE FAMILIARIZATION · 05 MIN</p><h1>Get to know your<br><em>space. And your cues.</em></h1><p class="lede">Five simple ways an object can get your attention.<br>Explore them one at a time, in the room around you.</p></section>
    <section class="workspace">
      <div class="stage"><div class="stage-top"><span id="stage-mode">OBJECT PREVIEW</span><span id="stage-state">Loading models</span></div><div id="viewport"></div><div class="stage-bottom"><span id="variation">Delivery bag + Focus moon</span><span id="clock">05:00</span></div><div class="progress"><div id="progress-fill"></div></div></div>
      <aside><p class="eyebrow">YOUR FIVE FEATURES</p><ol class="features">${FEATURE_NAMES.map((name, i) => `<li data-feature="${i}"><span class="feature-number">0${i + 1}</span><div><strong>${name.replace(/^\d+\.\s*/, "")}</strong><small>${["Delivery bag & Focus moon", "Small, medium, large", "Near, middle, far · table & floor", "Still, floating, approaching", "Silent, single, repeated"][i]}</small></div><span class="feature-indicator">↗</span></li>`).join("")}</ol><div class="setup-note"><span>01 → 02 → 03</span><p>Enter passthrough. Scan your room.<br>Confirm the floor and table to begin.</p></div></aside>
    </section>
    <section class="actions"><div class="entry-actions"><button id="enter-ar" class="primary" disabled>Loading models…</button><button id="preview" disabled>Start desktop preview <span>↗</span></button></div><p id="status" role="status" aria-live="polite">Loading your supplied 3D objects…</p></section>
    <section id="playback" class="playback" hidden><button id="previous">← Previous</button><button id="pause">Pause</button><button id="replay">Replay feature</button><button id="next">Next →</button><button id="rescan">Scan room</button><button id="stop">End preview</button></section>
    <footer><span>One feature at a time. A moment to notice the difference.</span><details><summary>Headset controls & room setup</summary><p>Trigger: confirm surface / start / pause. Left X: previous. Right A: next. Right B: replay. Left Y: scan room.</p><p>Look at the floor, then your table. Allow room access. If no surfaces appear, use Left Y to scan, or complete Space Setup in Quest settings and include the table. Remain in one comfortable position during the demonstration.</p><p>Desktop preview uses a simulated room. Space: pause. Arrow keys: previous / next. R: replay. Drag to orbit, scroll to zoom while previewing objects.</p></details></footer>
  </main>`;

const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const viewport = element<HTMLDivElement>("viewport");
const status = element<HTMLParagraphElement>("status");
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, 1, 0.05, 30);
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setClearColor(0, 0);
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.xr.enabled = true;
viewport.append(renderer.domElement);
scene.add(camera, new THREE.HemisphereLight(0xffffff, 0xa0adb2, 2.4));
const keyLight = new THREE.DirectionalLight(0xffffff, 3);
keyLight.position.set(2, 5, 3); scene.add(keyLight);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.minDistance = 0.7; controls.maxDistance = 5;
controls.maxPolarAngle = Math.PI * 0.75;
const demo = new Demonstration();
const scanner = new RoomScanner();
const panel = new SpatialPanel();
scene.add(demo.group, scanner.group, panel.mesh);

type Mode = "loading" | "landing" | "scanning" | "running" | "complete";
let mode: Mode = "loading";
let elapsed = 0;
let paused = false;
let lastTime = 0;
let tracked = true;
let room: RoomSnapshot | null = null;
let scanError = "";
let scanGeneration = 0;
let capturing = false;
let captureToken = 0;
const viewerPosition = new THREE.Vector3();
const viewerOrientation = new THREE.Quaternion();
const forward = new THREE.Vector3();
const focusPoint = new THREE.Vector3();
const buttonState = new Map<XRInputSource, boolean[]>();

const ar = new ARSession(renderer, element<HTMLButtonElement>("enter-ar"), {
  unlockAudio: () => { void demo.unlockAudio().catch(audioError); },
  onStatus: text => { status.textContent = text; },
  async onStart(session, space) {
    controls.enabled = false;
    document.body.classList.add("in-xr");
    session.addEventListener("select", primaryAction);
    space.addEventListener("reset", resetRoom);
    session.addEventListener("visibilitychange", () => {
      lastTime = 0;
      if (session.visibilityState !== "visible") demo.stopAudio();
    });
    await startScan();
  },
  onEnd() {
    scanGeneration++;
    captureToken++; capturing = false;
    scanner.stop(); demo.stopAudio(); panel.hide(); buttonState.clear();
    document.body.classList.remove("in-xr");
    controls.enabled = true;
    resetPreview();
    status.textContent = "AR session ended. You can enter again for a fresh room setup.";
  },
});

function audioError(error: unknown): void {
  status.textContent = `Sound could not start: ${error instanceof Error ? error.message : error}. Press a trigger or the pause/resume button to retry.`;
}

const previewRoom = {
  floorY: 0, tablePosition: new THREE.Vector3(0, 0.75, -1.35),
  viewerPosition: new THREE.Vector3(0, 1.6, 0), forward: new THREE.Vector3(0, 0, -1),
  floorPolygon: [new THREE.Vector3(-2, 0, 1), new THREE.Vector3(2, 0, 1), new THREE.Vector3(2, 0, -3), new THREE.Vector3(-2, 0, -3)],
  tablePolygon: [new THREE.Vector3(-0.6, 0.75, -1.05), new THREE.Vector3(0.6, 0.75, -1.05), new THREE.Vector3(0.6, 0.75, -1.65), new THREE.Vector3(-0.6, 0.75, -1.65)],
};

function resetPreview(): void {
  mode = "landing"; paused = false; elapsed = 0; lastTime = 0;
  camera.fov = 60;
  camera.aspect = viewport.clientWidth / Math.max(1, viewport.clientHeight);
  camera.updateProjectionMatrix();
  renderer.setSize(viewport.clientWidth, viewport.clientHeight);
  camera.position.set(0, 1.52, -0.35);
  controls.target.set(0, 1.31, -1.25); controls.update();
  demo.setPlacement(previewRoom); demo.render(0, 0);
  element("stage-mode").textContent = "OBJECT PREVIEW";
  element("stage-state").textContent = "Drag to explore";
  element("variation").textContent = "Delivery bag + Focus moon";
  element("playback").hidden = true;
  updateChrome();
}

async function startScan(): Promise<void> {
  const {session, space} = ar;
  if (!session || !space) return;
  const generation = ++scanGeneration;
  demo.hide(); demo.stopAudio(); scanner.stop();
  mode = "scanning"; paused = false; room = null; elapsed = 0; lastTime = 0; scanError = "";
  panel.show("Look around your room", "Find the floor and your table.\nLeft Y: scan room · Trigger: confirm surface");
  element("playback").hidden = false;
  element("stop").textContent = "Exit AR";
  try { await scanner.start(session, space); }
  catch (error) { if (generation === scanGeneration) scanError = String(error); }
  updateChrome();
}

function resetRoom(): void { demo.hide(); demo.stopAudio(); void startScan(); }

async function captureRoom(): Promise<void> {
  if (!ar.session || capturing) return;
  const session = ar.session;
  const token = ++captureToken;
  capturing = true;
  await startScan();
  if (session !== ar.session || token !== captureToken) return;
  try { await ar.captureRoom(); }
  catch (error) { if (session === ar.session && token === captureToken) scanError = error instanceof Error ? error.message : String(error); }
  finally { if (session === ar.session && token === captureToken) { capturing = false; lastTime = 0; } }
}

function begin(): void {
  try {
    if (ar.session) {
      if (!room?.ready || !room.floor || !room.table) return;
      forward.set(0, 0, -1).applyQuaternion(viewerOrientation); forward.y = 0; forward.normalize();
      demo.setPlacement({floorY: room.floor.position.y, tablePosition: room.table.position,
        viewerPosition, forward, floorPolygon: room.floor.polygon, tablePolygon: room.table.polygon});
      scanner.group.visible = false;
    } else {
      camera.position.copy(previewRoom.viewerPosition);
      camera.quaternion.identity();
      controls.enabled = false;
      demo.setPlacement(previewRoom);
    }
  } catch (error) {
    scanError = error instanceof Error ? error.message : String(error);
    status.textContent = scanError;
    return;
  }
  mode = "running"; paused = false; elapsed = 0; lastTime = 0;
  element("playback").hidden = false;
  element("stop").textContent = ar.session ? "Exit AR" : "End preview";
  element("stage-mode").textContent = ar.session ? "PASSTHROUGH AR" : "SIMULATED ROOM · DESKTOP PREVIEW";
  status.textContent = "Three-second title cards introduce each feature. The full sequence lasts five minutes.";
  updateChrome();
}

function primaryAction(): void {
  void demo.unlockAudio().catch(audioError);
  if (mode === "scanning") {
    if (room?.ready) begin(); else scanner.confirmCandidate();
  } else if (mode === "complete") begin();
  else if (mode === "running") { paused = !paused; lastTime = 0; demo.stopAudio(); updateChrome(); }
}

function changeFeature(delta: number): void {
  if (mode !== "running" && mode !== "complete") return;
  const index = mode === "complete" ? 4 : Math.min(4, Math.floor(elapsed / FEATURE_SECONDS));
  elapsed = Math.max(0, Math.min(4, index + delta)) * FEATURE_SECONDS;
  mode = "running"; paused = false; lastTime = 0;
  demo.stopAudio(); demo.hide(); updateChrome();
}

element("preview").addEventListener("click", () => { if (!ar.session) { void demo.unlockAudio().catch(audioError); begin(); } });
element("pause").addEventListener("click", primaryAction);
element("previous").addEventListener("click", () => changeFeature(-1));
element("next").addEventListener("click", () => changeFeature(1));
element("replay").addEventListener("click", () => changeFeature(0));
element("rescan").addEventListener("click", () => { void captureRoom(); });
element("stop").addEventListener("click", () => { if (ar.session) void ar.end(); else { controls.enabled = true; demo.stopAudio(); panel.hide(); resetPreview(); } });
window.addEventListener("keydown", event => {
  if (event.repeat || (event.target as HTMLElement)?.closest("button, input, textarea, summary")) return;
  if (event.code === "Space") { event.preventDefault(); primaryAction(); }
  if (event.code === "ArrowLeft") changeFeature(-1);
  if (event.code === "ArrowRight") changeFeature(1);
  if (event.code === "KeyR") changeFeature(0);
});
document.addEventListener("visibilitychange", () => {
  lastTime = 0;
  if (document.hidden) demo.stopAudio();
});

function pollControllers(session: XRSession): void {
  for (const source of session.inputSources) {
    if (!source.gamepad) continue;
    const previous = buttonState.get(source) ?? [];
    source.gamepad.buttons.forEach((button, index) => {
      if (button.pressed && !previous[index]) {
        if (index === 4) changeFeature(source.handedness === "left" ? -1 : 1);
        if (index === 5 && source.handedness === "left") void captureRoom();
        if (index === 5 && source.handedness === "right") changeFeature(0);
      }
      previous[index] = button.pressed;
    });
    buttonState.set(source, previous);
  }
  for (const source of buttonState.keys()) if (!Array.from(session.inputSources).includes(source)) buttonState.delete(source);
}

let lastUiKey = "";
function updateChrome(label?: string): void {
  const state = getTimelineState(elapsed);
  const uiKey = `${mode}|${paused}|${Math.ceil(elapsed)}|${label ?? ""}`;
  if (uiKey === lastUiKey) return;
  lastUiKey = uiKey;
  document.querySelectorAll<HTMLElement>("[data-feature]").forEach(item => {
    const i = Number(item.dataset.feature);
    item.classList.toggle("active", (mode === "running" || mode === "complete") && i === state.featureIndex);
    item.classList.toggle("done", mode === "complete" || (mode === "running" && i < state.featureIndex));
  });
  const remaining = Math.max(0, Math.ceil(TOTAL_SECONDS - elapsed));
  element("clock").textContent = `${String(Math.floor(remaining / 60)).padStart(2,"0")}:${String(remaining % 60).padStart(2,"0")}`;
  element("progress-fill").style.width = `${elapsed / TOTAL_SECONDS * 100}%`;
  element("pause").textContent = mode === "scanning" ? "Confirm / Start" : mode === "complete" ? "Start again" : paused ? "Resume" : "Pause";
  element<HTMLButtonElement>("rescan").disabled = !ar.session || capturing;
  for (const id of ["previous", "next", "replay"]) element<HTMLButtonElement>(id).disabled = mode === "scanning";
  if (label) element("variation").textContent = label;
  if (mode === "running") element("stage-state").textContent = paused ? "Paused" : `${state.featureIndex + 1} / 5 · ${state.phase === "intro" ? "Introduction" : "Demonstration"}`;
  if (mode === "complete") element("stage-state").textContent = "Complete";
}

new ResizeObserver(() => {
  if (renderer.xr.isPresenting) return;
  const {width, height} = viewport.getBoundingClientRect();
  camera.aspect = width / Math.max(1, height); camera.updateProjectionMatrix();
  renderer.setSize(width, height);
}).observe(viewport);

renderer.setAnimationLoop((time: number, frame?: XRFrame) => {
  const delta = lastTime ? Math.max(0, (time - lastTime) / 1000) : 0;
  lastTime = time;
  let projection: ArrayLike<number> = camera.projectionMatrix.elements;
  const session = ar.session;
  if (session && ar.space && frame) {
    const pose = frame.getViewerPose(ar.space);
    const wasTracked = tracked;
    tracked = Boolean(pose) && session.visibilityState === "visible";
    if (pose) {
      viewerPosition.set(pose.transform.position.x, pose.transform.position.y, pose.transform.position.z);
      viewerOrientation.set(pose.transform.orientation.x, pose.transform.orientation.y, pose.transform.orientation.z, pose.transform.orientation.w);
      projection = pose.views[0]?.projectionMatrix ?? projection;
    }
    if (!tracked) { demo.group.visible = false; demo.stopAudio(); panel.hide(); renderer.clear(); return; }
    if (!wasTracked) lastTime = 0;
    pollControllers(session);
    if (!capturing) {
      room = scanner.update(frame, time);
      if ((mode === "running" || mode === "complete") && !room.ready) { void startScan(); }
    }
    if (mode === "scanning") {
      panel.show(room?.ready ? "Your room is ready" : "Scan your surroundings",
        scanError || (room?.ready ? "Floor + table found. Face the table.\nPress a trigger to start the five features." : `${room?.message ?? "Look around slowly to locate the floor and table."}\nLook at the surface · Trigger to confirm · Left Y to scan`));
      status.textContent = scanError || room?.message || "Scanning room";
    }
  } else {
    if (controls.enabled) controls.update();
    camera.getWorldPosition(viewerPosition); camera.getWorldQuaternion(viewerOrientation);
  }
  demo.updateListener(viewerPosition, viewerOrientation);
  if (mode === "running") {
    if (!paused && !document.hidden && (!session || tracked) && delta < 1 && lastTime !== 0) elapsed = Math.min(TOTAL_SECONDS, elapsed + delta);
    const state = getTimelineState(elapsed);
    if (state.phase === "complete") {
      mode = "complete"; demo.hide(); demo.stopAudio();
      panel.show("Familiarization complete", "You have explored all five features.\nTrigger to start again, or exit AR.");
      updateChrome("All five features complete");
    } else if (paused) {
      demo.group.visible = false; panel.show("Paused", `${FEATURE_NAMES[state.featureIndex]}\nPress a trigger to continue.`); updateChrome();
    } else if (state.phase === "intro") {
      demo.hide(); demo.stopAudio(); panel.show(FEATURE_NAMES[state.featureIndex], "", "title"); updateChrome("Watch for the next feature");
    } else {
      panel.hide();
      const result = demo.render(state.featureIndex, state.demoSeconds);
      // Desktop has no head tracking: aim at each placement so the floor example stays visible.
      if (!session) {
        camera.lookAt(demo.getFocusPoint(focusPoint));
        camera.getWorldQuaternion(viewerOrientation);
        demo.updateListener(viewerPosition, viewerOrientation);
      }
      updateChrome(result.label);
    }
  }
  if (mode === "complete") panel.show("Familiarization complete", "You have explored all five features.\nTrigger to start again, or exit AR.");
  panel.follow(viewerPosition, viewerOrientation, projection);
  renderer.render(scene, camera);
});

void demo.load().then(() => {
  resetPreview(); element<HTMLButtonElement>("preview").disabled = false; void ar.check();
}).catch(error => {
  status.textContent = `Unable to load the supplied models: ${error instanceof Error ? error.message : String(error)}. Check the assets folder, then reload.`;
  element("stage-state").textContent = "Model loading failed"; console.error(error);
});

window.addEventListener("pagehide", () => {
  renderer.setAnimationLoop(null); demo.dispose(); scanner.dispose(); panel.dispose(); controls.dispose();
  void ar.end(); renderer.dispose();
}, {once: true});
