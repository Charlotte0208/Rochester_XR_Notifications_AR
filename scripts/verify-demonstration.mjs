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

const { FEATURE_NAMES, FEATURE_SECONDS, TOTAL_SECONDS, OBJECT_SIZES, getTimelineState, soundAppearance } = await import(moduleUrl("sequence"));
const { createPlacementPlan, insideSurface } = await import(moduleUrl("placement"));
const { Demonstration } = await import(moduleUrl("Demonstration"));
const rectangle = (left, right, near, far, y = 0) => [
  new THREE.Vector3(left, y, near), new THREE.Vector3(right, y, near),
  new THREE.Vector3(right, y, far), new THREE.Vector3(left, y, far)
];
const placement = {
  viewerPosition: new THREE.Vector3(0, 1.6, 0),
  forward: new THREE.Vector3(0, 0, -1),
  tablePosition: new THREE.Vector3(0, 0.75, -1.25),
  tablePolygon: rectangle(-0.6, 0.6, -0.95, -1.55, 0.75)
};

assert.equal(FEATURE_NAMES.length, 5);
assert.equal(FEATURE_SECONDS, 18);
assert.ok(FEATURE_SECONDS <= 20, "every feature including its title is at most twenty seconds");
assert.equal(TOTAL_SECONDS, 90);
for (let feature = 0; feature < 5; feature++) {
  for (const offset of [0, 1, 2.999]) {
    const state = getTimelineState(feature * 18 + offset);
    assert.equal(state.phase, "intro");
    assert.equal(state.featureIndex, feature);
    assert.equal(state.demoSeconds, 0);
  }
  assert.equal(getTimelineState(feature * 18 + 3).phase, "demonstration");
  assert.equal(getTimelineState(feature * 18 + 17.999).featureIndex, feature);
}
assert.equal(getTimelineState(90).phase, "complete");
assert.equal(getTimelineState(999).phase, "complete");
assert.equal(getTimelineState(-1).featureIndex, 0);
assert.equal(getTimelineState(NaN).featureIndex, 0);

const plan = createPlacementPlan(placement);
const distance = (point) => Math.hypot(point.x, point.z);
assert.ok(plan.tableBounded);
assert.ok(plan.scale > 0.8 && plan.scale <= 1, "largest object adapts to the measured table");
assert.ok(distance(plan.near) < distance(plan.distanceMiddle) && distance(plan.distanceMiddle) < distance(plan.far));
assert.ok(distance(plan.far) - distance(plan.near) > 0.3, "near/far use the full usable table rather than a short central path");
assert.equal(plan.middle.y, 0.753);
const unboundedInput = { ...placement, tablePolygon: [] };
const compact = createPlacementPlan(unboundedInput);
assert.equal(compact.tableBounded, false, "a hit point does not invent table boundaries");
assert.equal(unboundedInput.tablePolygon.length, 0);
assert.equal(compact.scale, 0.45);
assert.ok(compact.near.distanceTo(compact.middle) >= 0.15 && compact.near.distanceTo(compact.middle) < 0.18);
assert.ok(compact.far.distanceTo(compact.middle) >= 0.15 && compact.far.distanceTo(compact.middle) < 0.18);
const smallInput = { ...placement, tablePolygon: rectangle(-0.15, 0.15, -1.15, -1.35, 0.75) };
const small = createPlacementPlan(smallInput);
assert.ok(small.tableBounded && small.scale > 0 && small.scale < 0.5, "a small table adapts sizes instead of blocking all features");

// Decoding models alone must not create a default table or allow any feature to appear.
const unplaced = new Demonstration();
unplaced.loader.loadAsync = async () => {
  const scene = new THREE.Group();
  scene.add(new THREE.Mesh(new THREE.BoxGeometry(0.6, 1, 0.4), new THREE.MeshBasicMaterial()));
  return { scene };
};
await unplaced.load();
for (let feature = 0; feature < 5; feature++) {
  assert.equal(unplaced.render(feature, 0).objectCount, 0, "no objects before explicit table placement");
  assert.equal(unplaced.group.visible, false, "decoded models stay hidden while waiting for a scan");
}
unplaced.setPlacement(placement);
assert.equal(unplaced.render(0, 0).objectCount, 2, "an explicitly supplied table enables the first feature");
unplaced.dispose();

// Inject simple stand-ins to inspect the actual renderer without requiring a GPU.
const demo = new Demonstration();
demo.bag = new THREE.Group();
demo.moon = new THREE.Group();
demo.group.add(demo.bag, demo.moon);
demo.setPlacement(placement);
assert.equal(demo.render(0, 0).objectCount, 2);
assert.ok(demo.bag.position.distanceTo(demo.moon.position) > demo.bag.scale.x);
const focus = demo.getFocusPoint(new THREE.Vector3());
assert.ok(Math.abs(focus.x - plan.middle.x) < 1e-8);
assert.ok(Math.abs(focus.y - plan.middle.y - 0.14 * plan.scale) < 1e-8);
const sizes = [];
const sizePositions = [];
for (const seconds of [0, 5, 10]) {
  const result = demo.render(1, seconds);
  assert.equal(result.objectCount, 1);
  assert.equal(result.label, ["Small", "Medium", "Large"][sizes.length], "size label contains no measurements");
  sizes.push(demo.bag.scale.x);
  sizePositions.push(demo.bag.position.clone());
}
assert.deepEqual(sizes, OBJECT_SIZES.map(size => size * plan.scale));
assert.ok(Math.abs(sizes[2] / sizes[0] - 8) < 1e-8, "large is eight times small on its longest side");
assert.ok(sizePositions[0].equals(sizePositions[1]) && sizePositions[0].equals(sizePositions[2]), "only size varies");
for (const [index, seconds] of [0, 5, 10].entries()) {
  const frame = demo.render(2, seconds + 1e-6);
  assert.equal(frame.objectCount, 1);
  assert.equal(demo.bag.scale.x, 0.28 * plan.scale);
  assert.equal(demo.bag.position.y, 0.753);
  assert.equal(frame.label, `${["Near", "Middle", "Far"][index]} position on the table`);
}
assert.ok(Math.abs(demo.getFocusPoint(focus).y - plan.middle.y - 0.14 * plan.scale) < 1e-8, "Spatial sound targets the tabletop object centre");
demo.render(3, 0);
const still = demo.bag.position.clone();
demo.render(3, 3);
assert.ok(still.equals(demo.bag.position));
demo.render(3, 3.75 + 1);
const slowPeak = demo.bag.position.clone();
demo.render(3, 7.5 + 0.3);
assert.ok(slowPeak.distanceTo(demo.bag.position) < 1e-8, "slow and faster movement use the same path and amplitude");
demo.render(3, 11.25);
const arrivalStart = demo.bag.position.clone().sub(plan.middle);
assert.ok(arrivalStart.dot(plan.right) < -0.4 && arrivalStart.dot(plan.up) > 0.4, "starts left and high");
assert.ok(distance(demo.bag.position) > distance(plan.far), "arrival begins farther away than the table");
let previousSide = -Infinity, landings = 0, wasLanded = false;
for (let step = 0; step <= 150; step++) {
  demo.render(3, 11.25 + step / 150 * 3.75);
  const offset = demo.bag.position.clone().sub(plan.middle);
  const side = offset.dot(plan.right);
  assert.ok(side >= previousSide - 1e-8, "one-way arc never reverses toward the left");
  assert.ok(offset.dot(plan.up) >= -1e-8, "arc never passes below the table");
  const landed = offset.length() < 1e-7;
  if (landed && !wasLanded) landings++;
  wasLanded = landed; previousSide = side;
}
assert.equal(landings, 1, "one arrival and one landing, without repetition");
const departureEnd = demo.bag.position.clone().sub(plan.middle);
assert.ok(departureEnd.dot(plan.right) > 0.4 && departureEnd.dot(plan.up) > 0.4, "finishes right and high");

// Check the full model footprints, including interiors, on compact/concave/rotated tables.
const tilt = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.1, 0.6, 0));
const worldPolygon = (points, quaternion = new THREE.Quaternion()) => points.map(point => point.clone().applyQuaternion(quaternion).add(placement.tablePosition));
const concave = [[-0.6, -0.4], [0.6, -0.4], [0.6, -0.05], [0, -0.05], [0, 0.4], [-0.6, 0.4]]
  .map(([x, z]) => new THREE.Vector3(x, 0, z));
for (const input of [placement, smallInput,
  { ...placement, tablePolygon: rectangle(-0.4, 0.4, -1.17, -1.33, 0.75) },
  { ...placement, tableQuaternion: tilt, tablePolygon: worldPolygon(rectangle(-0.6, 0.6, 0.3, -0.3), tilt) },
  { ...placement, tablePolygon: worldPolygon(concave) },
  { ...placement, tablePosition: new THREE.Vector3(0.58, 0.75, -0.97) }
]) {
  const example = new Demonstration();
  example.bag = new THREE.Group();
  example.moon = new THREE.Group();
  example.group.add(example.bag, example.moon);
  example.setPlacement(input);
  assert.ok(example.plan.tableBounded);
  const inverse = (input.tableQuaternion ?? new THREE.Quaternion()).clone().invert();
  const localPolygon = input.tablePolygon.map(point => point.clone().sub(input.tablePosition).applyQuaternion(inverse));
  for (let feature = 0; feature < 5; feature++) {
    for (let seconds = 0; seconds < 15; seconds += 0.5) {
      const result = example.render(feature, seconds);
      assert.ok(result.objectCount === (feature === 0 ? 2 : feature === 4 ? Number(soundAppearance(seconds % 5, Math.floor(seconds / 5)).visible) : 1));
      for (const model of [example.bag, example.moon].filter(model => model.visible)) {
        const bottom = model.position.clone().sub(input.tablePosition).applyQuaternion(inverse);
        assert.ok(bottom.y >= 0.003 - 1e-8, "objects never move below the tabletop");
        if (feature !== 3) assert.ok(Math.abs(bottom.y - 0.003) < 1e-8, "stationary examples rest on the tabletop");
        if (feature === 3 && seconds >= 11.25) continue; // Requested airborne entry/exit intentionally extends beyond the tabletop.
        for (let x = -5; x <= 5; x++) for (let z = -5; z <= 5; z++) {
          const point = new THREE.Vector3(x / 10, 0, z / 10).multiplyScalar(model.scale.x)
            .applyQuaternion(model.quaternion).add(model.position).sub(input.tablePosition).applyQuaternion(inverse);
          assert.ok(insideSurface(point, localPolygon), `full footprint stays inside table: feature ${feature}, ${seconds}s`);
        }
      }
    }
  }
  const factor = example.plan.scale;
  assert.equal(example.render(0, 0).objectCount, 2);
  assert.ok(Math.abs(example.bag.scale.x / 0.28 - factor) < 1e-8);
  for (const [index, seconds] of [0, 5, 10].entries()) {
    example.render(1, seconds);
    assert.ok(Math.abs(example.bag.scale.x / OBJECT_SIZES[index] - factor) < 1e-8, "one scale factor applies to every feature");
  }
  example.dispose();
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
for (let seconds = 0; seconds < 5; seconds += 0.1) demo.render(4, seconds);
assert.equal(scheduled.length, 0, "silent condition schedules no tones");
demo.render(4, 5);
assert.equal(scheduled.length, 2, "one chime is a two-note envelope");
demo.stopAudio();
demo.render(4, 5.01);
assert.equal(scheduled.length, 2, "pause/resume does not duplicate a delivered chime");
for (let seconds = 5.1; seconds < 10; seconds += 0.1) demo.render(4, seconds);
assert.equal(scheduled.length, 2, "single-chime condition sounds once");
for (let seconds = 10; seconds < 15; seconds += 0.1) demo.render(4, seconds);
assert.equal(scheduled.length, 16, "the final condition plays seven short chimes at higher frequency");
demo.hide();
demo.render(4, 5);
assert.equal(scheduled.length, 18, "replay re-arms the single sound condition");
for (let condition = 0; condition < 3; condition++) {
  let appearances = 0, previousVisible = false;
  for (let step = 0; step < 100; step++) {
    const seconds = step * 0.05;
    const result = demo.render(4, condition * 5 + seconds);
    const expected = soundAppearance(seconds, condition).visible;
    assert.equal(result.objectCount, Number(expected));
    assert.equal(result.label, ["no sound", "quick sound", "repetitive sound"][condition], "caption identifies the current sound condition");
    if (expected && !previousVisible) appearances++;
    previousVisible = expected;
  }
  assert.equal(appearances, 1, "each sound condition shows its object once, without visual looping");
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
  checks: ["no objects before explicit table placement", "automatic five-feature timeline", "three-second titles", "stationary tabletop footprints", "compact, concave and tilted tables", "eightfold size contrast", "wider distance contrast", "unknown extent stays explicit", "single left-table-right arc", "one appearance per sound condition", "three distinct sound captions", "seven faster repeated chimes", "pause/replay audio", "supplied GLB integrity"]
}, null, 2));
