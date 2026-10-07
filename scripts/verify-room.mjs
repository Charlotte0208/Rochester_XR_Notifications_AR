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
const { polygonAreaXZ, polygonCenter, pointInPolygonXZ, gazeIntersection, plausibleTabletop, isHorizontal } = await import(geometryUrl);
const { RoomScanner } = await import(compile("../src/xr/RoomScanner.ts", { "./roomGeometry": geometryUrl }));
let checks = 0;
async function check(name, run) { await run(); checks++; console.log(`PASS ${name}`); }
const v = (x, y, z) => new THREE.Vector3(x, y, z);
const square = [v(-1, 0, -1), v(1, 0, -1), v(1, 0, 1), v(-1, 0, 1)];
class Session extends EventTarget {
  visibilityState = "visible";
  async requestReferenceSpace() { return new EventTarget(); }
}
function transform(position, quaternion = new THREE.Quaternion()) {
  return { position, orientation: quaternion, matrix: new THREE.Matrix4().compose(position, quaternion, v(1, 1, 1)).toArray() };
}
function plane(label = "table", y = 0.75, z = -1.5) {
  return { semanticLabel: label, orientation: "horizontal", planeSpace: {}, lastChangedTime: 0,
    polygon: [v(-0.6, 0, -0.4), v(0.6, 0, -0.4), v(0.6, 0, 0.4), v(-0.6, 0, 0.4)],
    pose: { transform: transform(v(0, y, z)) } };
}
function frame(session, planes, { target = v(0, 0.75, -1.5), head = v(0, 1.6, 0), hits = [] } = {}) {
  const orientation = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().lookAt(head, target, v(0, 1, 0)));
  return { session, detectedPlanes: new Set(planes),
    getViewerPose: () => ({ transform: transform(head, orientation) }),
    getPose: space => planes.find(p => p.planeSpace === space)?.pose,
    getHitTestResults: () => hits.map(position => ({ getPose: () => ({ transform: transform(position) }) })) };
}
function frames(scanner, value, start = 0, end = 1500) {
  for (let time = start; time <= end; time += 100) scanner.update(value, time);
  return scanner.getSnapshot();
}
async function setup(options = {}, session = new Session()) {
  const scanner = new RoomScanner();
  const space = new EventTarget();
  await scanner.start(session, space, options);
  return { scanner, session, space };
}

await check("Measured polygons preserve area, boundaries, and concave placement", () => {
  assert.equal(polygonAreaXZ(square), 4);
  assert.equal(polygonAreaXZ([...square].reverse()), 4);
  assert.equal(pointInPolygonXZ(v(1, 0, 0), square), true);
  assert.equal(pointInPolygonXZ(v(1.01, 0, 0), square), false);
  assert.equal(pointInPolygonXZ(v(0, 0, 0), []), false);
  const concave = [[0, 0], [3, 0], [3, 1], [1, 1], [1, 2], [3, 2], [3, 3], [0, 3]].map(([x, z]) => v(x, 0, z));
  assert.equal(pointInPolygonXZ(polygonCenter(concave), concave), true);
});
await check("Table guards reject floor height, walls, and gaze misses", () => {
  assert.ok(gazeIntersection(v(0, 1.6, 0), v(0, -1, 0), square, new THREE.Quaternion()));
  assert.equal(gazeIntersection(v(3, 1.6, 0), v(0, -1, 0), square, new THREE.Quaternion()), null);
  assert.equal(isHorizontal(new THREE.Quaternion().setFromAxisAngle(v(1, 0, 0), Math.PI / 2)), false);
  assert.equal(plausibleTabletop(0.75, 1.6, 0, false), true);
  assert.equal(plausibleTabletop(0, 1.05, 0, false), false);
  assert.equal(plausibleTabletop(0, 1.05, undefined, false), false);
  assert.equal(plausibleTabletop(1.55, 1.6, 0, true), false);
});
await check("A semantic table automatically becomes ready with no floor or input action", async () => {
  const { scanner, session } = await setup();
  const value = frame(session, [plane()]);
  assert.equal(frames(scanner, value, 0, 800).ready, false);
  const result = scanner.update(value, 900);
  assert.equal(result.ready, true);
  assert.equal(result.table.source, "semantic");
  assert.equal(result.table.polygon[0].y, 0.75);
  assert.equal("floor" in result, false);
  assert.equal(typeof scanner.confirmCandidate, "undefined");
  assert.doesNotMatch(result.message, /trigger|confirm|button/i);
  scanner.dispose();
});
await check("Semantic table behind the viewer cannot start the sequence", async () => {
  const { scanner, session } = await setup();
  assert.equal(frames(scanner, frame(session, [plane("table", 0.75, 1.5)])).ready, false);
  scanner.dispose();
});
await check("Unlabeled table needs continuous gaze before automatic readiness", async () => {
  const { scanner, session } = await setup({ floorSpace: true });
  const table = plane("");
  assert.equal(frames(scanner, frame(session, [table]), 0, 1000).ready, false);
  scanner.update(frame(session, [table], { target: v(0, 1.6, 1) }), 1100);
  assert.equal(frames(scanner, frame(session, [table]), 1200, 2400).ready, false);
  assert.equal(scanner.update(frame(session, [table]), 2500).ready, true);
  assert.equal(scanner.getSnapshot().table.source, "geometry");
  scanner.dispose();
});
await check("An unlabeled seated floor is rejected with and without local-floor space", async () => {
  for (const floorSpace of [false, true]) {
    const { scanner, session } = await setup({ floorSpace });
    const result = frames(scanner, frame(session, [plane("", 0)], { head: v(0, 1.05, 0), target: v(0, 0, -1.5) }));
    assert.equal(result.table, null);
    scanner.dispose();
  }
});
await check("Known floor and sofa labels are never reinterpreted as tables", async () => {
  for (const label of ["floor", "sofa", "ceiling"]) {
    const { scanner, session } = await setup();
    assert.equal(frames(scanner, frame(session, [plane(label)])).ready, false);
    scanner.dispose();
  }
});
await check("Position jitter and long frame gaps restart surface stability", async () => {
  const { scanner, session } = await setup();
  const table = plane();
  frames(scanner, frame(session, [table]), 0, 600);
  table.pose = { transform: transform(v(0.08, 0.75, -1.5)) };
  assert.equal(frames(scanner, frame(session, [table]), 700, 1200).ready, false);
  assert.equal(scanner.update(frame(session, [table]), 2500).ready, false);
  assert.equal(frames(scanner, frame(session, [table]), 2600, 3400).ready, true);
  scanner.dispose();
});
await check("Removing a tracked tabletop and resetting the origin clear readiness", async () => {
  const { scanner, session, space } = await setup();
  const table = plane();
  assert.equal(frames(scanner, frame(session, [table])).ready, true);
  assert.equal(scanner.update(frame(session, []), 1600).table, null);
  assert.equal(frames(scanner, frame(session, [table]), 1700, 2700).ready, true);
  space.dispatchEvent(new Event("reset"));
  assert.equal(scanner.getSnapshot().table, null);
  assert.equal(scanner.getSnapshot().ready, false);
  scanner.dispose();
});
await check("Tracking and hidden sessions cannot complete an unfinished scan", async () => {
  const { scanner, session } = await setup();
  const value = frame(session, [plane()]);
  frames(scanner, value, 0, 600);
  session.visibilityState = "hidden";
  session.dispatchEvent(new Event("visibilitychange"));
  assert.equal(scanner.update(value, 1600).ready, false);
  session.visibilityState = "visible";
  assert.equal(frames(scanner, value, 1700, 2500).ready, false);
  assert.equal(scanner.update(value, 2600).ready, true);
  value.getViewerPose = () => null;
  assert.equal(scanner.update(value, 2700).ready, false);
  scanner.dispose();
});
await check("Native room capture is requested only after tracked scanning time", async () => {
  const { scanner, session } = await setup();
  const value = frame(session, []);
  assert.equal(frames(scanner, value, 0, 2900).needsRoomCapture, false);
  assert.equal(scanner.update(value, 3000).needsRoomCapture, true);
  scanner.stop();
  await scanner.start(session, new EventTarget());
  session.visibilityState = "hidden";
  assert.equal(frames(scanner, value, 0, 5000).needsRoomCapture, false);
  scanner.dispose();
});
await check("Stable hit-test fallback starts automatically without fabricated extents", async () => {
  let cancelled = 0;
  const session = new Session();
  session.requestHitTestSource = async () => ({ cancel: () => { cancelled++; } });
  const { scanner } = await setup({ floorSpace: true }, session);
  const result = frames(scanner, frame(session, [], { hits: [v(0, 0.75, -1.5)] }));
  assert.equal(result.ready, true);
  assert.equal(result.table.source, "hit-test");
  assert.deepEqual(result.table.polygon, []);
  scanner.stop();
  assert.equal(cancelled, 1);
  assert.equal(scanner.getSnapshot().table, null);
  scanner.dispose();
});
await check("Hit testing cannot bypass a semantic sofa or measured floor", async () => {
  const session = new Session();
  session.requestHitTestSource = async () => ({ cancel() {} });
  const { scanner } = await setup({}, session);
  assert.equal(frames(scanner, frame(session, [plane("sofa")], { hits: [v(0, 0.75, -1.5)] })).ready, false);
  scanner.dispose();
});
await check("Rejected optional hit test leaves plane-only automatic scanning functional", async () => {
  const session = new Session();
  session.requestHitTestSource = async () => { throw new Error("Not supported"); };
  const { scanner } = await setup({}, session);
  assert.equal(frames(scanner, frame(session, [plane()])).ready, true);
  scanner.dispose();
});
await check("Stopping a pending source request cancels its eventual result", async () => {
  const scanner = new RoomScanner();
  const session = new Session();
  let resolveSource;
  let cancelled = 0;
  session.requestHitTestSource = () => new Promise(resolve => { resolveSource = resolve; });
  const pending = scanner.start(session, new EventTarget());
  await Promise.resolve();
  scanner.stop();
  resolveSource({ cancel: () => { cancelled++; } });
  await pending;
  assert.equal(cancelled, 1);
  assert.equal(scanner.getSnapshot().ready, false);
  scanner.dispose();
});
console.log(`${checks} automatic table scanning checks passed. Mocked XR checks do not establish Quest hardware acceptance.`);
