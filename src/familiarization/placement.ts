import * as THREE from "three";

export type DemonstrationPlacement = {
  floorY: number;
  tablePosition: THREE.Vector3;
  viewerPosition: THREE.Vector3;
  forward: THREE.Vector3;
  floorPolygon?: THREE.Vector3[];
  tablePolygon?: THREE.Vector3[];
};

export type PlacementPlan = {
  near: THREE.Vector3;
  middle: THREE.Vector3;
  far: THREE.Vector3;
  tabletop: THREE.Vector3;
  floor: THREE.Vector3;
  right: THREE.Vector3;
  yaw: number;
  roomBounded: boolean;
};

const UP = new THREE.Vector3(0, 1, 0);

export function distanceToSurfaceEdge(point: THREE.Vector3, polygon: readonly THREE.Vector3[]): number {
  let distance = Infinity;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[j];
    const b = polygon[i];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const lengthSquared = dx * dx + dz * dz;
    const t = lengthSquared > 0
      ? THREE.MathUtils.clamp(((point.x - a.x) * dx + (point.z - a.z) * dz) / lengthSquared, 0, 1)
      : 0;
    distance = Math.min(distance, Math.hypot(point.x - a.x - t * dx, point.z - a.z - t * dz));
  }
  return distance;
}

/** XZ polygon containment including a margin for the full object footprint. */
export function insideSurface(point: THREE.Vector3, polygon: readonly THREE.Vector3[], margin = 0): boolean {
  if (polygon.length < 3) return false;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[j];
    const b = polygon[i];
    if ((a.z > point.z) !== (b.z > point.z)
      && point.x < (b.x - a.x) * (point.z - a.z) / (b.z - a.z) + a.x) {
      inside = !inside;
    }
  }
  const minimumEdgeDistance = distanceToSurfaceEdge(point, polygon);
  return (inside || minimumEdgeDistance < 1e-7) && minimumEdgeDistance + 1e-7 >= margin;
}

function pointAlong(viewer: THREE.Vector3, direction: THREE.Vector3, distance: number, height: number): THREE.Vector3 {
  return viewer.clone().addScaledVector(direction, distance).setY(height);
}

/** Find a clear visible floor point, never deliberately underneath the identified table. */
function floorPoint(input: DemonstrationPlacement, forward: THREE.Vector3): THREE.Vector3 {
  const floorPolygon = input.floorPolygon;
  const tablePolygon = input.tablePolygon;
  for (const degrees of [0, 15, -15, 30, -30, 45, -45, 60, -60, 75, -75]) {
    const direction = forward.clone().applyAxisAngle(UP, THREE.MathUtils.degToRad(degrees));
    for (const distance of [1, 0.75, 1.25, 1.5, 1.75, 2, 0.55]) {
      const point = pointAlong(input.viewerPosition, direction, distance, input.floorY + 0.012);
      if (floorPolygon && floorPolygon.length >= 3 && !insideSurface(point, floorPolygon, 0.22)) continue;
      // A table scan without an extent gets a conservative 55 cm exclusion radius.
      const tableDistance = Math.hypot(point.x - input.tablePosition.x, point.z - input.tablePosition.z);
      const underTable = tablePolygon && tablePolygon.length >= 3
        ? insideSurface(point, tablePolygon)
          || distanceToSurfaceEdge(point, tablePolygon) < 0.22
        : tableDistance < 0.77;
      if (!underTable) return point;
    }
  }
  throw new Error("No clear floor area was found in front of you. Face an open floor area beside the table and scan again.");
}

function tabletopPoint(input: DemonstrationPlacement): THREE.Vector3 {
  const point = input.tablePosition.clone().add(new THREE.Vector3(0, 0.012, 0));
  const polygon = input.tablePolygon;
  if (!polygon || polygon.length < 3 || insideSurface(point, polygon, 0.21)) return point;
  // A selected hit near an edge is moved inward while retaining the measured height.
  const bounds = new THREE.Box3().setFromPoints(polygon);
  let best: THREE.Vector3 | null = null;
  let bestDistance = Infinity;
  for (let x = bounds.min.x; x <= bounds.max.x; x += 0.04) {
    for (let z = bounds.min.z; z <= bounds.max.z; z += 0.04) {
      const candidate = new THREE.Vector3(x, point.y, z);
      const distance = candidate.distanceToSquared(point);
      if (distance < bestDistance && insideSurface(candidate, polygon, 0.21)) {
        best = candidate;
        bestDistance = distance;
      }
    }
  }
  if (best) return best;
  throw new Error("The identified tabletop is too small for the object. Scan a larger clear tabletop area.");
}

export function createPlacementPlan(input: DemonstrationPlacement): PlacementPlan {
  const forward = input.forward.clone().setY(0);
  if (forward.lengthSq() < 1e-6) forward.set(0, 0, -1);
  forward.normalize();
  const polygon = input.floorPolygon;
  let distances = [0.75, 1.25, 1.75];
  let direction = forward.clone();
  let roomBounded = false;
  if (polygon && polygon.length >= 3) {
    let bestScore = -Infinity;
    for (const degrees of [0, 15, -15, 30, -30, 45, -45, 60, -60]) {
      const candidateDirection = forward.clone().applyAxisAngle(UP, THREE.MathUtils.degToRad(degrees));
      const available: number[] = [];
      // Use one contiguous interval so approach/recede cannot cross an unscanned gap.
      let interval: number[] = [];
      for (let step = 0; step <= 30; step += 1) {
        const distance = 0.55 + step * 0.05;
        const point = pointAlong(input.viewerPosition, candidateDirection, distance, input.floorY);
        if (insideSurface(point, polygon, 0.43)) {
          interval.push(distance);
        } else {
          if (interval.length > available.length) available.splice(0, available.length, ...interval);
          interval = [];
        }
      }
      if (interval.length > available.length) available.splice(0, available.length, ...interval);
      if (available.length < 5) continue;
      const first = available[0];
      const last = available[available.length - 1];
      const score = Math.min(1, last - first) - Math.abs(degrees) * 0.003;
      if (score <= bestScore) continue;
      bestScore = score;
      direction = candidateDirection;
      const near = THREE.MathUtils.clamp(0.75, first, Math.max(first, last - 0.2));
      const far = THREE.MathUtils.clamp(1.75, near + 0.2, last);
      distances = [near, (near + far) / 2, far];
      roomBounded = true;
    }
    if (!roomBounded) {
      throw new Error("The scanned floor is too small for three distinct viewing distances. Look around to scan more of the room.");
    }
  }
  // Floating examples clear the real tabletop and stay at a comfortable viewing height.
  const floatingY = Math.max(input.floorY + 0.8, input.viewerPosition.y - 0.42, input.tablePosition.y + 0.16);
  const near = pointAlong(input.viewerPosition, direction, distances[0], floatingY);
  const middle = pointAlong(input.viewerPosition, direction, distances[1], floatingY);
  const far = pointAlong(input.viewerPosition, direction, distances[2], floatingY);
  const right = direction.clone().cross(UP).normalize();
  return {
    near,
    middle,
    far,
    tabletop: tabletopPoint(input),
    floor: floorPoint(input, forward),
    right,
    yaw: Math.atan2(-direction.x, -direction.z),
    roomBounded
  };
}
