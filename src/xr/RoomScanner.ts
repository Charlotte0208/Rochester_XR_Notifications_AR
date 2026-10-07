import * as THREE from "three";
import { gazeIntersection, isHorizontal, polygonAreaXZ, polygonCenter, plausibleTabletop, validTableHeight } from "./roomGeometry";

export type Surface = {
  kind: "table";
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  /** Measured world-space vertices; [] means a hit-test point with unknown extent. */
  polygon: THREE.Vector3[];
  source: "semantic" | "geometry" | "hit-test";
};

export type RoomSnapshot = {
  table: Surface | null;
  ready: boolean;
  message: string;
  /** Caller may request native Room Setup once; no controller action is needed. */
  needsRoomCapture: boolean;
};

type PlaneRecord = { plane: XRPlane; surface: Surface; label: string; area: number };
type Candidate = { surface: Surface; plane: XRPlane | null; since: number; anchor: THREE.Vector3; rotation: THREE.Quaternion };
const STABLE_SEMANTIC_MS = 900;
const STABLE_GEOMETRY_MS = 1300;
const MAX_FRAME_GAP_MS = 250;

/** Automatically locates a tabletop using room geometry; no camera images or synthetic planes. */
export class RoomScanner {
  readonly group = new THREE.Group();
  private session: XRSession | null = null;
  private space: XRReferenceSpace | null = null;
  private hitSource: XRHitTestSource | null = null;
  private floorSpace = false;
  private generation = 0;
  private lastFrameTime: number | null = null;
  private emptyScanMs = 0;
  private selectedPlane: XRPlane | null = null;
  private candidate: Candidate | null = null;
  private snapshot: RoomSnapshot = this.emptySnapshot("Enter AR to find your table.");
  private readonly outline = new THREE.LineLoop(
    new THREE.BufferGeometry(),
    new THREE.LineBasicMaterial({ color: 0xffd278, transparent: true, opacity: 0.85, depthTest: false })
  );
  private readonly reticle = new THREE.Mesh(
    new THREE.RingGeometry(0.037, 0.052, 32).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0xffd278, side: THREE.DoubleSide, depthTest: false, transparent: true, opacity: 0.9 })
  );

  constructor() {
    this.group.name = "Automatic table scan";
    this.outline.renderOrder = 14;
    this.reticle.renderOrder = 15;
    this.group.add(this.outline, this.reticle);
    this.clearGuides();
  }

  private readonly onReset = (): void => { this.clear("Tracking changed. Look at your table again."); };
  private readonly onEnd = (): void => { this.stop(); };
  private readonly onVisibility = (): void => {
    this.candidate = null;
    this.lastFrameTime = null;
    this.snapshot.ready = false;
    this.snapshot.needsRoomCapture = false;
    this.clearGuides();
  };

  async start(session: XRSession, space: XRReferenceSpace, options: { floorSpace?: boolean } = {}): Promise<void> {
    this.stop();
    const generation = ++this.generation;
    this.session = session;
    this.space = space;
    this.floorSpace = options.floorSpace === true;
    this.group.visible = true;
    this.clear("Look at your tabletop. The demonstration will start automatically.");
    session.addEventListener("end", this.onEnd);
    session.addEventListener("visibilitychange", this.onVisibility);
    space.addEventListener("reset", this.onReset);
    // Optional hit-test rejection must not block Quest plane-only room data.
    if (!session.requestHitTestSource) return;
    try {
      const viewer = await session.requestReferenceSpace("viewer");
      if (generation !== this.generation) return;
      const source = await session.requestHitTestSource({ space: viewer, entityTypes: ["plane"] });
      if (generation !== this.generation) {
        try { source?.cancel(); } catch { /* Session already ended. */ }
      } else this.hitSource = source ?? null;
    } catch {
      if (generation === this.generation) this.hitSource = null;
    }
  }

  update(frame: XRFrame, timeMs: number): RoomSnapshot {
    if (!this.session || !this.space || frame.session !== this.session) return this.getSnapshot();
    const viewer = this.session.visibilityState === "visible" ? frame.getViewerPose(this.space) : null;
    if (!viewer) {
      this.onVisibility();
      this.snapshot.message = "Waiting for tracking. Look at your table when the view returns.";
      return this.getSnapshot();
    }
    const delta = this.lastFrameTime === null ? 0 : timeMs - this.lastFrameTime;
    if (delta < 0 || delta > MAX_FRAME_GAP_MS) this.candidate = null;
    this.lastFrameTime = timeMs;
    const head = new THREE.Vector3().copy(viewer.transform.position);
    const direction = new THREE.Vector3(0, 0, -1).applyQuaternion(new THREE.Quaternion().copy(viewer.transform.orientation));
    const records = this.readPlanes(frame);
    // A measured semantic floor improves rejection in local space, but is never required.
    const measuredFloor = records.find(record => record.label === "floor")?.surface.position.y;
    const floorY = this.floorSpace ? 0 : measuredFloor;

    if (this.selectedPlane) {
      const selected = records.find(record => record.plane === this.selectedPlane);
      if (!selected || (selected.label && selected.label !== "table")
        || (floorY !== undefined && !validTableHeight(selected.surface.position.y, floorY))) {
        this.snapshot.table = null;
        this.selectedPlane = null;
      } else this.snapshot.table = selected.surface;
    }

    if (!this.snapshot.table) {
      let next: { surface: Surface; plane: XRPlane | null } | null = null;
      let bestScore = Infinity;
      let plausiblePlane = false;
      for (const record of records) {
        if (record.label && record.label !== "table") continue;
        const semantic = record.label === "table";
        const surface = record.surface;
        if (record.area < 0.09 || !plausibleTabletop(surface.position.y, head.y, floorY, semantic)) continue;
        const offset = surface.position.clone().sub(head);
        const distance = offset.length();
        if (distance < 0.3 || distance > 4) continue;
        plausiblePlane = true;
        const hit = gazeIntersection(head, direction, surface.polygon, surface.quaternion);
        const alignment = offset.normalize().dot(direction);
        // Semantic labels still need forward attention; never choose a table behind the user.
        if (!hit && (!semantic || alignment < Math.cos(35 * Math.PI / 180))) continue;
        const score = (semantic ? 0 : 10) + (hit ? 0 : 1) + (1 - alignment) + distance * 0.02;
        if (score < bestScore) { bestScore = score; next = { surface, plane: record.plane }; }
      }
      next ??= this.hitCandidate(frame, head, floorY, records);
      this.updateCandidate(next, timeMs);
      if (this.candidate) {
        const duration = this.candidate.surface.source === "semantic" ? STABLE_SEMANTIC_MS : STABLE_GEOMETRY_MS;
        if (timeMs - this.candidate.since >= duration) {
          this.snapshot.table = this.candidate.surface;
          this.selectedPlane = this.candidate.plane;
          this.candidate = null;
        }
      }
      this.emptyScanMs = next || plausiblePlane ? 0 : this.emptyScanMs + Math.max(0, Math.min(MAX_FRAME_GAP_MS, delta));
    }
    this.snapshot.ready = this.snapshot.table !== null;
    this.snapshot.needsRoomCapture = !this.snapshot.ready && this.emptyScanMs >= 3000;
    this.snapshot.message = this.snapshot.ready ? "Table found. Starting automatically."
      : this.candidate ? "Table found. Keep looking at it for a moment."
      : "Look slowly across your tabletop. The demonstration will start automatically.";
    this.drawGuides();
    return this.getSnapshot();
  }

  getSnapshot(): RoomSnapshot { return { ...this.snapshot }; }

  stop(): void {
    ++this.generation;
    this.session?.removeEventListener("end", this.onEnd);
    this.session?.removeEventListener("visibilitychange", this.onVisibility);
    this.space?.removeEventListener("reset", this.onReset);
    try { this.hitSource?.cancel(); } catch { /* Session already ended. */ }
    this.hitSource = null;
    this.session = null;
    this.space = null;
    this.clear("Enter AR to find your table.");
  }

  dispose(): void {
    this.stop();
    this.outline.geometry.dispose(); this.outline.material.dispose();
    this.reticle.geometry.dispose(); this.reticle.material.dispose();
    this.group.removeFromParent();
  }

  private readPlanes(frame: XRFrame): PlaneRecord[] {
    const records: PlaneRecord[] = [];
    for (const plane of frame.detectedPlanes ?? []) {
      const pose = frame.getPose(plane.planeSpace, this.space!);
      if (!pose || plane.orientation === "vertical") continue;
      const quaternion = new THREE.Quaternion().copy(pose.transform.orientation);
      if (!isHorizontal(quaternion)) continue;
      const matrix = new THREE.Matrix4().fromArray(pose.transform.matrix);
      const polygon = plane.polygon.map(point => new THREE.Vector3(point.x, point.y, point.z).applyMatrix4(matrix));
      const area = polygonAreaXZ(polygon);
      if (area < 0.04 || !polygon.every(point => Number.isFinite(point.x + point.y + point.z))) continue;
      const label = (plane.semanticLabel ?? "").toLowerCase().trim();
      records.push({ plane, label, area, surface: {
        kind: "table", position: polygonCenter(polygon), quaternion, polygon,
        source: label === "table" ? "semantic" : "geometry"
      } });
    }
    return records;
  }

  private hitCandidate(frame: XRFrame, head: THREE.Vector3, floorY: number | undefined, records: PlaneRecord[]): { surface: Surface; plane: null } | null {
    if (!this.hitSource || !frame.getHitTestResults) return null;
    try {
      for (const hit of frame.getHitTestResults(this.hitSource)) {
        const pose = hit.getPose(this.space!);
        if (!pose) continue;
        const position = new THREE.Vector3().copy(pose.transform.position);
        const quaternion = new THREE.Quaternion().copy(pose.transform.orientation);
        const distance = position.distanceTo(head);
        if (!isHorizontal(quaternion) || distance < 0.3 || distance > 4
          || !plausibleTabletop(position.y, head.y, floorY, false)) continue;
        // A hit must not override an explicit floor/sofa/etc. label at that point.
        if (records.some(record => record.label && record.label !== "table"
          && Math.abs(record.surface.position.y - position.y) < 0.08
          && gazeIntersection(head, position.clone().sub(head).normalize(), record.surface.polygon, record.surface.quaternion))) continue;
        return { surface: { kind: "table", position, quaternion, polygon: [], source: "hit-test" }, plane: null };
      }
    } catch { /* Hit testing may be unavailable while planes remain usable. */ }
    return null;
  }

  private updateCandidate(next: { surface: Surface; plane: XRPlane | null } | null, timeMs: number): void {
    if (!next) { this.candidate = null; return; }
    const previous = this.candidate;
    const same = previous && previous.plane === next.plane && previous.surface.source === next.surface.source
      && previous.anchor.distanceTo(next.surface.position) <= 0.05
      && previous.rotation.angleTo(next.surface.quaternion) <= 8 * Math.PI / 180;
    this.candidate = { ...next, since: same ? previous.since : timeMs,
      anchor: same ? previous.anchor : next.surface.position.clone(),
      rotation: same ? previous.rotation : next.surface.quaternion.clone() };
  }

  private emptySnapshot(message: string): RoomSnapshot { return { table: null, ready: false, message, needsRoomCapture: false }; }
  private clear(message: string): void {
    this.snapshot = this.emptySnapshot(message);
    this.selectedPlane = null;
    this.candidate = null;
    this.emptyScanMs = 0;
    this.lastFrameTime = null;
    this.clearGuides();
  }
  private drawGuides(): void {
    const surface = this.snapshot.table ?? this.candidate?.surface;
    this.reticle.visible = this.group.visible && !!surface;
    this.outline.visible = this.group.visible && !!surface && surface.polygon.length >= 3;
    if (!surface) return;
    const color = this.snapshot.ready ? 0x70e7ba : 0xffd278;
    this.reticle.material.color.setHex(color); this.outline.material.color.setHex(color);
    this.reticle.position.copy(surface.position); this.reticle.position.y += 0.012;
    this.reticle.quaternion.copy(surface.quaternion);
    if (this.outline.visible) {
      this.outline.geometry.setFromPoints(surface.polygon.map(point => point.clone().add(new THREE.Vector3(0, 0.008, 0))));
      this.outline.geometry.computeBoundingSphere();
    }
  }
  private clearGuides(): void { this.outline.visible = false; this.reticle.visible = false; }
}
