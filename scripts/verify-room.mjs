import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import * as THREE from "three";
import ts from "typescript";

const require = createRequire(import.meta.url);
const threeUrl = pathToFileURL(require.resolve("three")).href;
function compile(relative, imports = {}) {
  let code = ts.transpileModule(fs.readFileSync(new URL(relative, import.meta.url), "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ES2022 }
  }).outputText.replace(/from ["']three["']/g, `from ${JSON.stringify(threeUrl)}`);
  for (const [name, url] of Object.entries(imports)) code = code.replace(`from "${name}"`, `from ${JSON.stringify(url)}`);
  return `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;
}
const geometryUrl = compile("../src/xr/roomGeometry.ts");
const { polygonAreaXZ, polygonCenter, pointInPolygonXZ, gazeIntersection, validTableHeight, isHorizontal } = await import(geometryUrl);
const { RoomScanner } = await import(compile("../src/xr/RoomScanner.ts", { "./roomGeometry": geometryUrl }));
let checks = 0;
function check(name, run) { run(); checks++; console.log(`PASS ${name}`); }
const v = (x, y, z) => new THREE.Vector3(x, y, z);
const square = [v(-1, 0, -1), v(1, 0, -1), v(1, 0, 1), v(-1, 0, 1)];
check("Polygon area, winding, and boundary handling", () => {
  assert.equal(polygonAreaXZ(square), 4);
  assert.equal(polygonAreaXZ([...square].reverse()), 4);
  assert.equal(pointInPolygonXZ(v(1, 0, 0), square), true);
  assert.equal(pointInPolygonXZ(v(1.01, 0, 0), square), false);
  assert.equal(pointInPolygonXZ(v(0, 0, 0), []), false);
});
check("Concave surface placement remains inside measured polygon", () => {
  const cShape = [[0, 0], [3, 0], [3, 1], [1, 1], [1, 2], [3, 2], [3, 3], [0, 3]].map(([x, z]) => v(x, 0, z));
  assert.equal(pointInPolygonXZ(polygonCenter(cShape), cShape), true);
  assert.equal(pointInPolygonXZ(v(2, 0, 1.5), cShape), false);
});
check("Gaze intersections reject walls, misses, and backward rays", () => {
  const q = new THREE.Quaternion();
  assert.ok(gazeIntersection(v(0, 1.6, 0), v(0, -1, 0), square, q));
  assert.equal(gazeIntersection(v(3, 1.6, 0), v(0, -1, 0), square, q), null);
  assert.equal(gazeIntersection(v(0, 1.6, 0), v(0, 1, 0), square, q), null);
  assert.equal(isHorizontal(new THREE.Quaternion().setFromAxisAngle(v(1, 0, 0), Math.PI / 2)), false);
  assert.equal(validTableHeight(0.75, 0), true);
  assert.equal(validTableHeight(1.5, 0), false);
  assert.equal(validTableHeight(-0.4, 0), false);
});

class Session extends EventTarget {
  visibilityState = "visible";
  async requestReferenceSpace() { return new EventTarget(); }
}
function transform(position, quaternion = new THREE.Quaternion()) {
  return { position, orientation: quaternion, matrix: new THREE.Matrix4().compose(position, quaternion, v(1, 1, 1)).toArray() };
}
function plane(label, y, width, depth, z = -1.5) {
  return {
    semanticLabel: label, orientation: "horizontal", planeSpace: {}, lastChangedTime: 0,
    polygon: [v(-width / 2, 0, -depth / 2), v(width / 2, 0, -depth / 2), v(width / 2, 0, depth / 2), v(-width / 2, 0, depth / 2)],
    pose: { transform: transform(v(0, y, z)) }
  };
}
function makeFrame(session, planes, target = v(0, 0, -1.5), hits = []) {
  const position = v(0, 1.6, 0);
  const orientation = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().lookAt(position, target, v(0, 1, 0)));
  return {
    session, detectedPlanes: new Set(planes),
    getViewerPose: () => ({ transform: transform(position, orientation) }),
    getPose: space => planes.find(p => p.planeSpace === space)?.pose,
    getHitTestResults: () => hits.map(position => ({ getPose: () => ({ transform: transform(position) }) }))
  };
}
function frames(scanner, frame, start = 0, end = 800) {
  for (let time = start; time <= end; time += 100) scanner.update(frame, time);
  return scanner.getSnapshot();
}

const floor = plane("floor", 0, 5, 5);
const table = plane("table", 0.75, 1.2, 0.8);
const session = new Session();
const space = new EventTarget();
const scanner = new RoomScanner();
await scanner.start(session, space);
check("Semantic surfaces lock only after stable tracked frames, without hit test", () => {
  const frame = makeFrame(session, [floor, table]);
  assert.equal(scanner.update(frame, 0).ready, false);
  const snapshot = frames(scanner, frame, 100);
  assert.equal(snapshot.ready, true);
  assert.equal(snapshot.floor.source, "semantic");
  assert.equal(snapshot.table.source, "semantic");
  assert.equal(snapshot.table.polygon.length, 4);
  assert.equal(snapshot.table.polygon[0].y, 0.75);
});
check("Removing a tracked plane clears it and stops ready state", () => {
  const snapshot = scanner.update(makeFrame(session, [floor]), 900);
  assert.equal(snapshot.ready, false);
  assert.equal(snapshot.table, null);
  assert.ok(snapshot.floor);
});
check("Reference-space reset clears every surface and candidate", () => {
  space.dispatchEvent(new Event("reset"));
  assert.equal(scanner.getSnapshot().floor, null);
  assert.equal(scanner.getSnapshot().table, null);
  assert.equal(scanner.confirmCandidate(), false);
});
check("A semantic ceiling and an implausible tabletop cannot satisfy scanning", () => {
  const ceiling = plane("ceiling", 0, 5, 5);
  assert.equal(frames(scanner, makeFrame(session, [ceiling]), 1000, 1800).floor, null);
  assert.equal(frames(scanner, makeFrame(session, [floor, plane("table", 2, 1, 1)]), 1900, 2700).table, null);
});
scanner.stop();
await scanner.start(session, space);
const unnamedFloor = plane("", 0, 5, 5);
const unnamedTable = plane("", 0.75, 1.2, 0.8);
check("Unlabeled planes require stable gaze and separate floor/table confirmations", () => {
  const floorFrame = makeFrame(session, [unnamedFloor], v(0, 0, -1.5));
  scanner.update(floorFrame, 0);
  assert.equal(scanner.confirmCandidate(), false);
  assert.equal(frames(scanner, floorFrame, 100).floor, null);
  assert.equal(scanner.confirmCandidate(), true);
  const tableFrame = makeFrame(session, [unnamedFloor, unnamedTable], v(0, 0.75, -1.5));
  frames(scanner, tableFrame, 900, 1700);
  assert.equal(scanner.getSnapshot().table, null);
  assert.equal(scanner.confirmCandidate(), true);
  assert.equal(scanner.getSnapshot().ready, true);
  assert.equal(scanner.getSnapshot().table.source, "geometry");
});
check("Tracking loss disables ready and visibility/reset never accepts stale triggers", () => {
  const frame = makeFrame(session, [unnamedFloor, unnamedTable]);
  frame.getViewerPose = () => null;
  assert.equal(scanner.update(frame, 1800).ready, false);
  session.visibilityState = "hidden";
  session.dispatchEvent(new Event("visibilitychange"));
  assert.equal(scanner.confirmCandidate(), false);
  session.visibilityState = "visible";
  space.dispatchEvent(new Event("reset"));
});
scanner.dispose();

let cancellations = 0;
const hitSession = new Session();
hitSession.requestHitTestSource = async () => ({ cancel: () => { cancellations++; } });
const hitScanner = new RoomScanner();
await hitScanner.start(hitSession, new EventTarget());
check("Hit-test fallback confirms measured points and never fabricates polygons", () => {
  frames(hitScanner, makeFrame(hitSession, [], v(0, 0, -1), [v(0, 0, -1)]));
  assert.equal(hitScanner.confirmCandidate(), true);
  assert.equal(hitScanner.getSnapshot().floor.source, "hit-test");
  assert.deepEqual(hitScanner.getSnapshot().floor.polygon, []);
  frames(hitScanner, makeFrame(hitSession, [], v(0, 0.75, -1), [v(0, 0.75, -1)]), 900, 1700);
  assert.equal(hitScanner.confirmCandidate(), true);
  assert.equal(hitScanner.getSnapshot().ready, true);
});
check("Stopping cancels sources and clears confirmed data", () => {
  hitScanner.stop();
  assert.equal(cancellations, 1);
  assert.equal(hitScanner.getSnapshot().floor, null);
  assert.equal(hitScanner.getSnapshot().ready, false);
});
hitScanner.dispose();

const rejectedSession = new Session();
rejectedSession.requestHitTestSource = async () => { throw new Error("Unsupported optional feature"); };
const planeOnly = new RoomScanner();
await planeOnly.start(rejectedSession, new EventTarget());
check("Rejected optional hit test leaves semantic plane scanning functional", () => {
  assert.equal(frames(planeOnly, makeFrame(rejectedSession, [floor, table])).ready, true);
});
planeOnly.dispose();
console.log(`${checks} room scanning checks passed. Mocked XR checks do not establish Quest hardware acceptance.`);
