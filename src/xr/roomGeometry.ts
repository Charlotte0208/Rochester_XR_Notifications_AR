import * as THREE from "three";

/** Plane polygons are expressed in world/reference-space metres throughout the app. */
export function polygonAreaXZ(polygon: readonly THREE.Vector3[]): number {
  let area = 0;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i];
    const b = polygon[(i + 1) % polygon.length];
    area += a.x * b.z - b.x * a.z;
  }
  return Math.abs(area) / 2;
}

export function polygonCenter(polygon: readonly THREE.Vector3[]): THREE.Vector3 {
  const center = new THREE.Vector3();
  let signedArea = 0;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i];
    const b = polygon[(i + 1) % polygon.length];
    const cross = a.x * b.z - b.x * a.z;
    signedArea += cross;
    center.x += (a.x + b.x) * cross;
    center.z += (a.z + b.z) * cross;
    center.y += a.y;
  }
  if (polygon.length < 3 || Math.abs(signedArea) < 1e-8) {
    return polygon.reduce((sum, point) => sum.add(point), new THREE.Vector3())
      .divideScalar(Math.max(polygon.length, 1));
  }
  center.x /= 3 * signedArea;
  center.z /= 3 * signedArea;
  center.y /= polygon.length;
  if (!pointInPolygonXZ(center, polygon)) {
    // A concave plane's arithmetic/area centroid can fall outside its boundary.
    const triangles = THREE.ShapeUtils.triangulateShape(polygon.map(point => new THREE.Vector2(point.x, point.z)), []);
    let largest = 0;
    for (const indices of triangles) {
      const points = indices.map(index => polygon[index]);
      const area = polygonAreaXZ(points);
      if (area > largest) {
        largest = area;
        center.copy(points[0]).add(points[1]).add(points[2]).divideScalar(3);
      }
    }
  }
  return center;
}

/** Ray casting also handles concave floor outlines; empty hit-test polygons are unknown. */
export function pointInPolygonXZ(point: THREE.Vector3, polygon: readonly THREE.Vector3[]): boolean {
  if (polygon.length < 3) return false;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[j];
    const b = polygon[i];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const lengthSquared = dx * dx + dz * dz;
    if (lengthSquared > 0) {
      const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.z - a.z) * dz) / lengthSquared));
      if (Math.hypot(point.x - a.x - t * dx, point.z - a.z - t * dz) < 0.001) return true;
    }
    if ((a.z > point.z) !== (b.z > point.z)
      && point.x < (b.x - a.x) * (point.z - a.z) / (b.z - a.z) + a.x) inside = !inside;
  }
  return inside;
}

export function isHorizontal(quaternion: THREE.Quaternion): boolean {
  const normal = new THREE.Vector3(0, 1, 0).applyQuaternion(quaternion);
  return Number.isFinite(normal.y) && Math.abs(normal.y) >= Math.cos(12 * Math.PI / 180);
}

export function validTableHeight(tableY: number, floorY: number): boolean {
  const height = tableY - floorY;
  return Number.isFinite(height) && height >= 0.35 && height <= 1.4;
}

export function gazeIntersection(
  origin: THREE.Vector3,
  direction: THREE.Vector3,
  polygon: readonly THREE.Vector3[],
  quaternion: THREE.Quaternion
): THREE.Vector3 | null {
  if (polygon.length < 3) return null;
  const normal = new THREE.Vector3(0, 1, 0).applyQuaternion(quaternion);
  const denominator = direction.dot(normal);
  if (Math.abs(denominator) < 0.05) return null;
  const distance = polygon[0].clone().sub(origin).dot(normal) / denominator;
  if (distance < 0.25 || distance > 6) return null;
  const intersection = origin.clone().addScaledVector(direction, distance);
  return pointInPolygonXZ(intersection, polygon) ? intersection : null;
}
