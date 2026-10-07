import * as THREE from "three";
import { OBJECT_SIZES } from "./sequence";

/** The table pose and optional measured boundary are in XR reference-space metres. */
export type DemonstrationPlacement = {
  tablePosition: THREE.Vector3;
  tableQuaternion?: THREE.Quaternion;
  tablePolygon?: THREE.Vector3[];
  viewerPosition: THREE.Vector3;
  forward: THREE.Vector3;
};

export type ModelFootprints = {
  bag: { width: number; depth: number };
  moon: { width: number; depth: number };
};

export type PlacementPlan = {
  near: THREE.Vector3;
  middle: THREE.Vector3;
  far: THREE.Vector3;
  distanceMiddle: THREE.Vector3;
  right: THREE.Vector3;
  up: THREE.Vector3;
  rotation: THREE.Quaternion;
  scale: number;
  pairOffset: number;
  tableBounded: boolean;
  arrival: THREE.QuadraticBezierCurve3;
  departure: THREE.QuadraticBezierCurve3;
};

const DEFAULT_FOOTPRINTS: ModelFootprints = {
  bag: { width: 1, depth: 1 }, moon: { width: 1, depth: 1 }
};
const SURFACE_CLEARANCE = 0.003;

export function distanceToSurfaceEdge(point: THREE.Vector3, polygon: readonly THREE.Vector3[]): number {
  let distance = Infinity;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[j], b = polygon[i];
    const dx = b.x - a.x, dz = b.z - a.z;
    const lengthSquared = dx * dx + dz * dz;
    const t = lengthSquared > 0
      ? THREE.MathUtils.clamp(((point.x - a.x) * dx + (point.z - a.z) * dz) / lengthSquared, 0, 1)
      : 0;
    distance = Math.min(distance, Math.hypot(point.x - a.x - t * dx, point.z - a.z - t * dz));
  }
  return distance;
}

/** Containment in the table's local XZ plane; edge points are included. */
export function insideSurface(point: THREE.Vector3, polygon: readonly THREE.Vector3[], margin = 0): boolean {
  if (polygon.length < 3) return false;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[j], b = polygon[i];
    if ((a.z > point.z) !== (b.z > point.z)
      && point.x < (b.x - a.x) * (point.z - a.z) / (b.z - a.z) + a.x) inside = !inside;
  }
  const distance = distanceToSurfaceEdge(point, polygon);
  return (inside || distance < 1e-8) && distance + 1e-8 >= margin;
}

function cross(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3): number {
  return (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x);
}

/** Corner checks alone miss concave notches: also reject boundary crossings/interior vertices. */
function rectangleFits(center: THREE.Vector3, halfWidth: number, halfDepth: number, polygon: THREE.Vector3[]): boolean {
  const corners = [
    new THREE.Vector3(center.x - halfWidth, 0, center.z - halfDepth),
    new THREE.Vector3(center.x + halfWidth, 0, center.z - halfDepth),
    new THREE.Vector3(center.x + halfWidth, 0, center.z + halfDepth),
    new THREE.Vector3(center.x - halfWidth, 0, center.z + halfDepth)
  ];
  if (!corners.every(point => insideSurface(point, polygon))) return false;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i], b = polygon[(i + 1) % polygon.length];
    if (Math.abs(a.x - center.x) < halfWidth - 1e-8 && Math.abs(a.z - center.z) < halfDepth - 1e-8) return false;
    for (let j = 0; j < corners.length; j++) {
      const c = corners[j], d = corners[(j + 1) % corners.length];
      if (cross(a, b, c) * cross(a, b, d) < -1e-16
        && cross(c, d, a) * cross(c, d, b) < -1e-16) return false;
    }
  }
  return true;
}

function largestFit(center: THREE.Vector3, width: number, depth: number, polygon: THREE.Vector3[]): number {
  if (rectangleFits(center, width, depth, polygon)) return 1;
  let low = 0, high = 1;
  for (let iteration = 0; iteration < 18; iteration++) {
    const scale = (low + high) / 2;
    if (rectangleFits(center, width * scale, depth * scale, polygon)) low = scale;
    else high = scale;
  }
  return low;
}

export function createPlacementPlan(input: DemonstrationPlacement, footprints = DEFAULT_FOOTPRINTS): PlacementPlan {
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(input.tableQuaternion ?? new THREE.Quaternion()).normalize();
  if (up.y < 0) up.negate();
  const forward = input.tablePosition.clone().sub(input.viewerPosition).projectOnPlane(up);
  if (forward.lengthSq() < 1e-8) forward.copy(input.forward).projectOnPlane(up);
  if (forward.lengthSq() < 1e-8) forward.set(0, 0, -1).projectOnPlane(up);
  forward.normalize();
  const right = forward.clone().cross(up).normalize();
  const backward = forward.clone().negate();
  const rotation = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(right, up, backward));
  const inverse = rotation.clone().invert();
  const polygon = (input.tablePolygon ?? []).map(point => point.clone().sub(input.tablePosition).applyQuaternion(inverse).setY(0));
  let center = new THREE.Vector3();
  // With a hit point but no boundary, retain a compact arrangement without inventing a surface extent.
  let scale = 0.45;
  let tableBounded = false;
  let nearCenter = new THREE.Vector3(0, 0, 0.36 * scale);
  let farCenter = new THREE.Vector3(0, 0, -0.36 * scale);
  let distanceCenter = center.clone();

  if (polygon.length >= 3) {
    const bounds = new THREE.Box3().setFromPoints(polygon);
    const halfWidth = Math.max(OBJECT_SIZES[2] / 2 * footprints.bag.width,
      0.18 + 0.14 * Math.max(footprints.bag.width, footprints.moon.width)) + 0.01;
    const halfDepth = Math.max(OBJECT_SIZES[2] / 2 * footprints.bag.depth,
      0.14 * footprints.moon.depth) + 0.01;
    const candidates = [center.clone(), bounds.getCenter(new THREE.Vector3()).setY(0)];
    // Triangle centroids ensure a useful candidate even for a very thin or concave tabletop.
    const triangles = THREE.ShapeUtils.triangulateShape(polygon.map(point => new THREE.Vector2(point.x, point.z)), []);
    triangles.forEach(indices => candidates.push(indices.reduce((sum, index) => sum.add(polygon[index]), new THREE.Vector3()).divideScalar(3)));
    for (let x = 0; x <= 20; x++) for (let z = 0; z <= 20; z++) {
      candidates.push(new THREE.Vector3(
        THREE.MathUtils.lerp(bounds.min.x, bounds.max.x, x / 20), 0,
        THREE.MathUtils.lerp(bounds.min.z, bounds.max.z, z / 20)));
    }
    let bestScale = 0, bestDistance = Infinity;
    for (const candidate of candidates) {
      if (!insideSurface(candidate, polygon)) continue;
      const candidateScale = largestFit(candidate, halfWidth, halfDepth, polygon);
      const distance = candidate.lengthSq();
      if (candidateScale > bestScale + 1e-6 || (Math.abs(candidateScale - bestScale) <= 1e-6 && distance < bestDistance)) {
        bestScale = candidateScale;
        bestDistance = distance;
        center = candidate;
      }
    }
    if (bestScale > 0) {
      scale = bestScale;
      tableBounded = true;
      // Use the full measured surface instead of a short symmetric path around its centre.
      // Each distance example is stationary, so concave gaps need not connect the positions.
      const eye = input.viewerPosition.clone().sub(input.tablePosition).applyQuaternion(inverse).setY(0);
      const usable = [...candidates, center].filter(point => rectangleFits(point,
        (OBJECT_SIZES[1] / 2 * footprints.bag.width + 0.008) * scale,
        (OBJECT_SIZES[1] / 2 * footprints.bag.depth + 0.008) * scale, polygon));
      usable.sort((a, b) => a.distanceToSquared(eye) - b.distanceToSquared(eye));
      nearCenter = (usable[0] ?? center).clone();
      farCenter = (usable[usable.length - 1] ?? center).clone();
      const middleDistance = (nearCenter.distanceTo(eye) + farCenter.distanceTo(eye)) / 2;
      distanceCenter = usable.reduce((best, point) =>
        Math.abs(point.distanceTo(eye) - middleDistance) < Math.abs(best.distanceTo(eye) - middleDistance)
          ? point : best, center).clone();
    }
  }

  const world = (point: THREE.Vector3) => point.clone().applyQuaternion(rotation)
    .add(input.tablePosition).addScaledVector(up, SURFACE_CLEARANCE);
  const middle = world(center);
  const travel = Math.max(0.6, scale);
  const offset = (x: number, y: number, z: number) => middle.clone()
    .addScaledVector(right, x * travel).addScaledVector(up, y * travel).addScaledVector(forward, z * travel);
  return {
    near: world(nearCenter),
    middle,
    far: world(farCenter),
    distanceMiddle: world(distanceCenter),
    right, up, rotation, scale,
    pairOffset: 0.18 * scale,
    tableBounded,
    arrival: new THREE.QuadraticBezierCurve3(offset(-0.7, 0.72, 0.5), offset(-0.48, 0.12, 0.12), middle.clone()),
    departure: new THREE.QuadraticBezierCurve3(middle.clone(), offset(0.48, 0.12, 0), offset(0.75, 0.72, 0.12)),
  };
}
