import "./styles.css";
import * as THREE from "three";
import { ARSession } from "./xr/arSession";
import { RoomScanner, type Surface } from "./xr/RoomScanner";
import { SpatialPanel } from "./ui/SpatialPanel";
import { Demonstration } from "./familiarization/Demonstration";
import { FEATURE_NAMES, TOTAL_SECONDS, getTimelineState } from "./familiarization/sequence";

const app = document.querySelector<HTMLDivElement>("#app")!;
app.innerHTML = `
  <div id="viewport"></div>
  <main id="entry">
    <h1>AR Familiarization</h1>
    <p>Put on your Meta Quest 3.<br>Playback starts only after a real table is detected.</p>
    <div class="entry-buttons">
      <button id="enter-ar" disabled>Loading…</button>
    </div>
    <p id="status" role="status" aria-live="polite">Loading objects…</p>
  </main>`;

const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const entry = element("entry");
const status = element("status");
const viewport = element("viewport");
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.05, 30);
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setClearColor(0, 0);
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.xr.enabled = true;
viewport.append(renderer.domElement);
scene.add(camera, new THREE.HemisphereLight(0xffffff, 0x9e9990, 2.2));
const light = new THREE.DirectionalLight(0xffffff, 2.5);
light.position.set(2, 5, 3); scene.add(light);

const demo = new Demonstration();
const scanner = new RoomScanner();
const panel = new SpatialPanel();
scene.add(demo.group, scanner.group, panel.mesh);

type Mode = "loading" | "landing" | "scanning" | "running" | "complete";
let mode: Mode = "loading";
let elapsed = 0;
let previousFrame = 0;
let tracked = true;
let generation = 0;
let captureAttempted = false;
let capturing = false;
let scanNotice = "";
let disposed = false;
const viewerPosition = new THREE.Vector3();
const viewerOrientation = new THREE.Quaternion();
const forward = new THREE.Vector3();

function setMode(next: Mode): void {
  mode = next;
  document.body.dataset.mode = next;
  entry.hidden = next !== "landing" && next !== "loading";
  if (next !== "running") {
    delete document.body.dataset.phase;
    delete document.body.dataset.feature;
  }
}
setMode("loading");

const ar = new ARSession(renderer, element<HTMLButtonElement>("enter-ar"), {
  unlockAudio: () => { void demo.unlockAudio().catch(() => {}); },
  onStatus: message => { if (mode === "landing" || mode === "loading") status.textContent = message; },
  async onStart(session, space) {
    elapsed = 0; captureAttempted = false; capturing = false;
    scene.background = null;
    session.addEventListener("visibilitychange", resetFrameTime);
    space.addEventListener("reset", handleReferenceReset);
    await startScan();
  },
  onEnd() {
    if (disposed) return;
    generation++; capturing = false;
    scanner.stop(); demo.hide(); panel.hide();
    showLanding();
    status.textContent = "Session ended.";
  },
});

function resetFrameTime(): void { previousFrame = 0; demo.stopAudio(); }
function handleReferenceReset(): void { if (!capturing && mode !== "complete") void startScan(); }

function showLanding(): void {
  setMode("landing"); elapsed = 0; previousFrame = 0;
  scene.background = new THREE.Color(0xf4f4f1);
  camera.fov = 60; camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  camera.position.set(0, 1.6, 0);
  camera.quaternion.identity();
}

async function startScan(): Promise<void> {
  if (!ar.session || !ar.space) return;
  const run = ++generation;
  demo.group.visible = false; demo.stopAudio();
  setMode("scanning"); previousFrame = 0; scanNotice = "";
  panel.show("Look at your table");
  try { await scanner.start(ar.session, ar.space, {floorSpace: ar.floorSpace}); }
  catch (error) {
    if (run === generation) scanNotice = "Allow room access and include your table in Quest Space Setup.";
    console.error("Table scanning could not start.", error);
  }
}

async function requestRoomCapture(): Promise<void> {
  if (captureAttempted || capturing || !ar.session) return;
  captureAttempted = true; capturing = true;
  const run = generation;
  panel.show("Scan your table");
  try { await ar.captureRoom(); }
  catch (error) {
    if (run === generation) scanNotice = "Include your table in Quest Space Setup, then enter AR again.";
    console.info("Room capture is unavailable or was dismissed.", error);
  } finally {
    if (run === generation) { capturing = false; previousFrame = 0; }
  }
}

function begin(table: Surface): void {
  if (!ar.session || !ar.space || mode !== "scanning" || !scanner.getSnapshot().ready) return;
  try {
    forward.set(0, 0, -1).applyQuaternion(viewerOrientation).setY(0).normalize();
    demo.setPlacement({tablePosition: table.position, tableQuaternion: table.quaternion,
      tablePolygon: table.polygon, viewerPosition, forward});
  } catch (error) {
    scanNotice = "Look at a clear, flat area of the tabletop.";
    console.error("Table placement could not be prepared.", error);
    return;
  }
  scanner.group.visible = false;
  previousFrame = 0;
  setMode("running");
}

// No controller buttons or keyboard shortcuts advance, pause, or select features.
document.addEventListener("visibilitychange", resetFrameTime);
window.addEventListener("resize", () => {
  if (renderer.xr.isPresenting) return;
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

renderer.setAnimationLoop((time: number, frame?: XRFrame) => {
  let delta = previousFrame ? Math.max(0, (time - previousFrame) / 1000) : 0;
  previousFrame = time;
  let projection: ArrayLike<number> = camera.projectionMatrix.elements;
  if (ar.session) {
    if (!frame || !ar.space) { previousFrame = 0; renderer.clear(); return; }
    const pose = frame.getViewerPose(ar.space);
    const wasTracked = tracked;
    tracked = Boolean(pose) && ar.session.visibilityState === "visible";
    if (!tracked || !pose) {
      demo.group.visible = false; demo.stopAudio(); panel.hide(); previousFrame = 0; renderer.clear(); return;
    }
    if (!wasTracked) delta = 0;
    viewerPosition.copy(pose.transform.position);
    viewerOrientation.copy(pose.transform.orientation);
    projection = pose.views[0]?.projectionMatrix ?? projection;
    if (!capturing && mode !== "complete") {
      const room = scanner.update(frame, time);
      if (mode === "running" && !room.ready) { void startScan(); delta = 0; }
      if (mode === "scanning") {
        if (room.ready && room.table) begin(room.table);
        else if (room.needsRoomCapture && !captureAttempted) void requestRoomCapture();
        if (!capturing && mode === "scanning") {
          panel.show(scanNotice || "Look at your table");
        }
      }
    }
  } else {
    camera.getWorldPosition(viewerPosition); camera.getWorldQuaternion(viewerOrientation);
  }
  demo.updateListener(viewerPosition, viewerOrientation);
  if (ar.session && mode === "running") {
    // Background interruptions do not skip a title, condition, or sound cue.
    if (tracked && delta < 1 && previousFrame !== 0) elapsed = Math.min(TOTAL_SECONDS, elapsed + delta);
    const state = getTimelineState(elapsed);
    document.body.dataset.feature = String(state.featureIndex + 1);
    document.body.dataset.phase = state.phase;
    if (state.phase === "complete") {
      setMode("complete"); demo.hide();
    } else if (state.phase === "intro") {
      demo.hide(); panel.show(FEATURE_NAMES[state.featureIndex], "title");
    } else {
      panel.hide(); demo.render(state.featureIndex, state.demoSeconds);
    }
  }
  if (mode === "complete") panel.show("Complete");
  panel.follow(viewerPosition, viewerOrientation, projection);
  renderer.render(scene, camera);
});

void demo.load().then(() => {
  if (disposed) return;
  showLanding();
  void ar.check();
}).catch(error => {
  status.textContent = "The objects could not be loaded. Please reload this page.";
  console.error(error);
});

window.addEventListener("pagehide", () => {
  disposed = true; generation++; renderer.setAnimationLoop(null);
  demo.dispose(); scanner.dispose(); panel.dispose();
  void ar.end(); renderer.dispose();
}, {once: true});
