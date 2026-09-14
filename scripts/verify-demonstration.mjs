import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import * as THREE from "three";
import ts from "typescript";

const require = createRequire(import.meta.url);
const modules = new Map();
function moduleUrl(name) {
  if (modules.has(name)) return modules.get(name);
  const source = fs.readFileSync(new URL(`../src/familiarization/${name}.ts`, import.meta.url), "utf8");
  let output = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ES2022 }
  }).outputText;
  output = output.replace(/from\s+["'](three(?:\/[^"']*)?)["']/g, (_, specifier) =>
    `from ${JSON.stringify(pathToFileURL(require.resolve(specifier)).href)}`);
  output = output.replace(/from\s+["']\.\/([^"']+)["']/g, (_, dependency) =>
    `from ${JSON.stringify(moduleUrl(dependency))}`);
  const url = `data:text/javascript;base64,${Buffer.from(output).toString("base64")}`;
  modules.set(name, url);
  return url;
}

const { FEATURE_NAMES, TOTAL_SECONDS, getTimelineState, soundAppearance } = await import(moduleUrl("sequence"));
const { createPlacementPlan, insideSurface, distanceToSurfaceEdge } = await import(moduleUrl("placement"));
const { Demonstration } = await import(moduleUrl("Demonstration"));
const rectangle = (left, right, near, far, y = 0) => [
  new THREE.Vector3(left, y, near), new THREE.Vector3(right, y, near),
  new THREE.Vector3(right, y, far), new THREE.Vector3(left, y, far)
];
const placement = {
  floorY: 0,
  viewerPosition: new THREE.Vector3(0, 1.6, 0),
  forward: new THREE.Vector3(0, 0, -1),
  tablePosition: new THREE.Vector3(0.3, 0.75, -1.4),
  floorPolygon: rectangle(-2, 2, 1, -3),
  tablePolygon: rectangle(-0.2, 0.8, -1, -1.8, 0.75)
};

assert.equal(FEATURE_NAMES.length, 5);
assert.equal(TOTAL_SECONDS, 300);
for (let feature = 0; feature < 5; feature++) {
  for (const offset of [0, 1, 2.999]) {
    const state = getTimelineState(feature * 60 + offset);
    assert.equal(state.phase, "intro");
    assert.equal(state.featureIndex, feature);
    assert.equal(state.demoSeconds, 0);
  }
  assert.equal(getTimelineState(feature * 60 + 3).phase, "demonstration");
  assert.equal(getTimelineState(feature * 60 + 59.999).featureIndex, feature);
}
assert.equal(getTimelineState(300).phase, "complete");
assert.equal(getTimelineState(999).phase, "complete");
assert.equal(getTimelineState(-1).featureIndex, 0);
assert.equal(getTimelineState(NaN).featureIndex, 0);

const plan = createPlacementPlan(placement);
const distance = (point) => Math.hypot(point.x, point.z);
assert.ok(plan.roomBounded);
assert.ok(distance(plan.near) < distance(plan.middle) && distance(plan.middle) < distance(plan.far));
for (let step = 0; step <= 100; step++) {
  const point = plan.near.clone().lerp(plan.far, step / 100);
  assert.ok(insideSurface(point, placement.floorPolygon, 0.43), "the entire approach path fits the measured floor");
}
assert.ok(insideSurface(plan.tabletop, placement.tablePolygon, 0.21));
assert.ok(insideSurface(plan.floor, placement.floorPolygon, 0.22));
assert.ok(!insideSurface(plan.floor, placement.tablePolygon));
assert.ok(distanceToSurfaceEdge(plan.floor, placement.tablePolygon) >= 0.22);
assert.equal(plan.floor.y, 0.012);
assert.equal(plan.tabletop.y, 0.762);
assert.throws(() => createPlacementPlan({ ...placement, floorPolygon: rectangle(-0.2, 0.2, 0.2, -0.2) }), /scan/i);
assert.throws(() => createPlacementPlan({ ...placement, tablePolygon: rectangle(0.2, 0.4, -1.3, -1.5) }), /tabletop is too small/i);
const edgeSelection = createPlacementPlan({ ...placement, tablePosition: new THREE.Vector3(-0.19, 0.75, -1.01) });
assert.ok(insideSurface(edgeSelection.tabletop, placement.tablePolygon, 0.21), "table-edge selection moves inward");
const rotated = createPlacementPlan({
  ...placement,
  viewerPosition: new THREE.Vector3(2, 1.6, 3),
  forward: new THREE.Vector3(-1, 0, 0),
  tablePosition: new THREE.Vector3(0.6, 0.75, 3.3),
  floorPolygon: rectangle(-1, 3, 5, 1),
  tablePolygon: undefined
});
assert.ok(rotated.near.x > rotated.middle.x && rotated.middle.x > rotated.far.x);
assert.ok(Math.abs(rotated.near.z - 3) < 1e-8);

// Inject simple stand-ins to inspect the actual renderer without requiring a GPU.
const demo = new Demonstration();
demo.bag = new THREE.Group();
demo.moon = new THREE.Group();
demo.group.add(demo.bag, demo.moon);
demo.setPlacement(placement);
assert.equal(demo.render(0, 0).objectCount, 2);
assert.ok(demo.bag.position.distanceTo(demo.moon.position) > 0.4);
const focus = demo.getFocusPoint(new THREE.Vector3());
assert.ok(Math.abs(focus.x - plan.middle.x) < 1e-8);
assert.ok(Math.abs(focus.y - plan.middle.y - 0.14) < 1e-8);
const sizes = [];
const sizePositions = [];
for (const seconds of [0, 19, 38]) {
  assert.equal(demo.render(1, seconds).objectCount, 1);
  sizes.push(demo.bag.scale.x);
  sizePositions.push(demo.bag.position.clone());
}
assert.deepEqual(sizes, [0.14, 0.28, 0.48]);
assert.ok(sizePositions[0].equals(sizePositions[1]) && sizePositions[0].equals(sizePositions[2]), "only size varies");
for (const [index, seconds] of [0, 11.4, 22.8, 34.2, 45.6].entries()) {
  const frame = demo.render(2, seconds + 1e-6);
  assert.equal(frame.objectCount, 1);
  assert.equal(demo.bag.scale.x, 0.28);
  if (index === 3) assert.equal(demo.bag.position.y, 0.762);
  if (index === 4) assert.equal(demo.bag.position.y, 0.012);
}
assert.ok(Math.abs(demo.getFocusPoint(focus).y - 0.152) < 1e-8, 'Desktop floor framing targets the object centre');
demo.render(3, 0);
const still = demo.bag.position.clone();
demo.render(3, 10);
assert.ok(still.equals(demo.bag.position));
demo.render(3, 14.25 + 2);
const slowPeak = demo.bag.position.clone();
demo.render(3, 28.5 + 0.625);
assert.ok(slowPeak.distanceTo(demo.bag.position) < 1e-8, "slow and faster movement use the same path and amplitude");
for (let seconds = 42.75; seconds < 57; seconds += 0.1) {
  demo.render(3, seconds);
  assert.ok(insideSurface(demo.bag.position, placement.floorPolygon, 0.43));
  assert.ok(distance(demo.bag.position) >= distance(plan.near) - 1e-8);
  assert.ok(distance(demo.bag.position) <= distance(plan.far) + 1e-8);
}

const scheduled = [];
const parameter = () => ({ value: 0, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} });
globalThis.AudioContext = class {
  state = "suspended";
  currentTime = 0;
  destination = {};
  listener = Object.fromEntries(["position", "forward", "up"].flatMap((prefix) => ["X", "Y", "Z"].map((axis) => [`${prefix}${axis}`, parameter()])));
  async resume() { this.state = "running"; }
  async close() { this.state = "closed"; }
  createPanner() { return { positionX: parameter(), positionY: parameter(), positionZ: parameter(), connect() {}, disconnect() {} }; }
  createGain() { return { gain: parameter(), connect() {}, disconnect() {} }; }
  createOscillator() {
    return { frequency: parameter(), connect() {}, disconnect() {}, start() { scheduled.push(this); }, stop() {}, onended: null };
  }
};
await demo.unlockAudio();
demo.updateListener(new THREE.Vector3(1, 2, 3), new THREE.Quaternion());
assert.equal(demo.context.listener.positionX.value, 1);
demo.hide();
for (let seconds = 0; seconds < 19; seconds += 0.1) demo.render(4, seconds);
assert.equal(scheduled.length, 0, "silent condition schedules no tones");
demo.render(4, 19);
assert.equal(scheduled.length, 2, "one chime is a two-note envelope");
demo.stopAudio();
demo.render(4, 19.01);
assert.equal(scheduled.length, 2, "pause/resume does not duplicate a delivered chime");
for (let seconds = 19.1; seconds < 38; seconds += 0.1) demo.render(4, seconds);
assert.equal(scheduled.length, 2, "single-chime condition sounds once");
for (let seconds = 38; seconds < 57; seconds += 0.1) demo.render(4, seconds);
assert.equal(scheduled.length, 8, "repeated condition sounds at all three appearances");
demo.hide();
demo.render(4, 19);
assert.equal(scheduled.length, 10, "replay re-arms the sound condition");
for (const seconds of [0, 5.9, 6, 7, 7.5, 13.5, 15, 18]) {
  const expected = soundAppearance(seconds).visible;
  for (const phase of [0, 19, 38]) {
    assert.equal(demo.render(4, phase + seconds).objectCount, Number(expected), "appearance timing is matched between sound conditions");
  }
}
demo.hide();
assert.equal(demo.group.visible, false);
demo.dispose();

// Preserve and validate the exact supplied binaries used by the demonstration.
for (const filename of ["uber_eats_delivery_bag.glb", "apple_focus_moon.glb"]) {
  const bytes = fs.readFileSync(new URL(`../public/assets/notification-objects/${filename}`, import.meta.url));
  assert.equal(bytes.readUInt32LE(0), 0x46546c67, `${filename} is a binary glTF`);
  assert.equal(bytes.readUInt32LE(4), 2);
  assert.equal(bytes.readUInt32LE(8), bytes.length);
  const json = JSON.parse(bytes.subarray(20, 20 + bytes.readUInt32LE(12)).toString("utf8"));
  assert.ok(json.meshes.length > 0);
  assert.ok(json.scenes.length > 0);
  assert.ok(!json.extensionsRequired?.includes("KHR_draco_mesh_compression"), "assets require no unconfigured Draco decoder");
}
console.log(JSON.stringify({
  status: "passed",
  durationSeconds: TOTAL_SECONDS,
  features: FEATURE_NAMES.length,
  checks: ["three-second titles", "measured placement bounds", "free floor beside table", "one-property size/motion changes", "all sound conditions", "pause/replay audio", "supplied GLB integrity"]
}, null, 2));
