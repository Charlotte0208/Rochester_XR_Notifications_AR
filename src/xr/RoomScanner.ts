import * as THREE from "three";
import { gazeIntersection, isHorizontal, polygonAreaXZ, polygonCenter, validTableHeight } from "./roomGeometry";

export type Surface = {
  kind: "floor" | "table";
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  /** World-space XRPlane vertices, or [] when only a hit-test point is known. */
  polygon: THREE.Vector3[];
  source: "semantic" | "geometry" | "hit-test";
};

export type RoomSnapshot = {
  floor: Surface | null;
  table: Surface | null;
  ready: boolean;
  message: string;
};

type PlaneRecord = {
  plane: XRPlane;
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  polygon: THREE.Vector3[];
  label: string;
  area: number;
  stableSince: number;
  stablePosition: THREE.Vector3;
  stableQuaternion: THREE.Quaternion;
};

type Candidate = { surface: Surface; plane: XRPlane | null; since: number; anchor: THREE.Vector3 };
const STABILITY_MS = 650;
const MAX_FRAME_GAP_MS = 250;
const POSITION_TOLERANCE = 0.06;

/** Reads headset room geometry; it neither accesses camera images nor invents room surfaces. */
export class RoomScanner {
  readonly group = new THREE.Group();
  private session: XRSession | null = null;
  private space: XRReferenceSpace | null = null;
  private hitSource: XRHitTestSource | null = null;
  private generation = 0;
  private lastFrameTime = -Infinity;
  private snapshot: RoomSnapshot = { floor: null, table: null, ready: false, message: "Enter AR to scan the room." };
  private readonly records = new Map<XRPlane, PlaneRecord>();
  private readonly selected: Record<"floor" | "table", XRPlane | null> = { floor: null, table: null };
  private candidate: Candidate | null = null;
  private candidateStable = false;
  private readonly outlines = [this.makeOutline(0x70e7ba), this.makeOutline(0x6fbfff), this.makeOutline(0xffd278)];
  private readonly reticle = new THREE.Mesh(
    new THREE.RingGeometry(0.037, 0.052, 32).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0xffd278, side: THREE.DoubleSide, depthTest: false, transparent: true, opacity: 0.9 })
  );
  private readonly pointMarkers = [0x70e7ba, 0x6fbfff].map(color => {
    const marker = new THREE.Mesh(this.reticle.geometry, this.reticle.material.clone());
    marker.material.color.setHex(color);
    marker.renderOrder = 15;
    return marker;
  });

  constructor() {
    this.group.name = "Room scanning guides";
    this.group.add(...this.outlines, ...this.pointMarkers, this.reticle);
    this.reticle.renderOrder = 15;
    this.clearGuides();
  }

  private readonly onReset = (): void => {
    this.clearSurfaces("Tracking origin changed. Scan and confirm the floor and table again.");
  };
  private readonly onEnd = (): void => { this.stop(); };
  private readonly onVisibility = (): void => {
    this.candidate = null;
    this.candidateStable = false;
    this.lastFrameTime = -Infinity;
    for (const record of this.records.values()) record.stableSince = Infinity;
    if (this.session?.visibilityState !== "visible") {
      this.snapshot.ready = false;
      this.snapshot.message = "Room scanning is paused while the headset view is hidden.";
      this.clearGuides();
    }
  };

  async start(session: XRSession, space: XRReferenceSpace): Promise<void> {
    this.stop();
    const generation = ++this.generation;
    this.session = session;
    this.space = space;
    this.group.visible = true;
    this.clearSurfaces("Look around slowly to locate the floor and table.");
    session.addEventListener("end", this.onEnd);
    session.addEventListener("visibilitychange", this.onVisibility);
    space.addEventListener("reset", this.onReset);
    // Plane detection works independently; optional hit testing may be unavailable on Quest.
    if (!session.requestHitTestSource) return;
    try {
      const viewer = await session.requestReferenceSpace("viewer");
      if (generation !== this.generation) return;
      const source = await session.requestHitTestSource({ space: viewer, entityTypes: ["plane"] });
      if (generation !== this.generation) {
        try { source?.cancel(); } catch { /* Session may already have ended. */ }
        return;
      }
      this.hitSource = source ?? null;
    } catch {
      // Rejection of the optional API must not block semantic planes or gaze/polygon selection.
      if (generation === this.generation) this.hitSource = null;
    }
  }

  update(frame: XRFrame, timeMs: number): RoomSnapshot {
    if (!this.session || !this.space || frame.session !== this.session) return this.getSnapshot();
    if (this.session.visibilityState !== "visible") {
      this.snapshot.ready = false;
      this.clearGuides();
      return this.getSnapshot();
    }
    const viewer = frame.getViewerPose(this.space);
    if (!viewer) {
      this.candidate = null;
      this.candidateStable = false;
      this.snapshot.ready = false;
      this.snapshot.message = "Tracking is unavailable. Look around slowly to recover.";
      this.clearGuides();
      this.lastFrameTime = -Infinity;
      return this.getSnapshot();
    }
    const gap = timeMs - this.lastFrameTime > MAX_FRAME_GAP_MS || timeMs < this.lastFrameTime;
    this.lastFrameTime = timeMs;
    if (gap) {
      this.candidate = null;
      this.candidateStable = false;
      for (const record of this.records.values()) record.stableSince = timeMs;
    }
    const position = new THREE.Vector3().copy(viewer.transform.position);
    const rotation = new THREE.Quaternion().copy(viewer.transform.orientation);
    const direction = new THREE.Vector3(0, 0, -1).applyQuaternion(rotation);
    this.readPlanes(frame, timeMs);
    this.refreshSelected();

    for (const kind of ["floor", "table"] as const) {
      if (this.snapshot[kind] || (kind === "table" && !this.snapshot.floor)) continue;
      const matches = [...this.records.values()].filter(record =>
        record.label === kind && this.accepts(kind, record.position, position, record.area)
        && timeMs - record.stableSince >= STABILITY_MS
      ).sort((a, b) => a.position.distanceToSquared(position) - b.position.distanceToSquared(position));
      if (matches[0]) this.select(this.surface(matches[0], kind, "semantic"), matches[0].plane);
    }

    this.snapshot.ready = !!(this.snapshot.floor && this.snapshot.table);
    if (this.snapshot.ready) {
      this.candidate = null;
      this.candidateStable = false;
      this.snapshot.message = "Floor and table located. Check the green floor and blue table guides, then press the trigger to begin.";
    } else {
      const kind = this.snapshot.floor ? "table" : "floor";
      let candidate: { surface: Surface; plane: XRPlane | null } | null = null;
      let nearest = Infinity;
      for (const record of this.records.values()) {
        // Do not reinterpret a semantic sofa, ceiling, wall, etc. as a floor/table.
        if (record.label && record.label !== kind) continue;
        if (!this.accepts(kind, record.position, position, record.area)) continue;
        const point = gazeIntersection(position, direction, record.polygon, record.quaternion);
        if (!point || point.distanceToSquared(position) >= nearest) continue;
        nearest = point.distanceToSquared(position);
        const surface = this.surface(record, kind, record.label === kind ? "semantic" : "geometry");
        // Gaze selects the plane; use its measured centre for reproducible placement.
        candidate = { surface, plane: record.plane };
      }
      candidate ??= this.readHitCandidate(frame, kind, position);
      this.updateCandidate(candidate, timeMs);
      const prefix = this.snapshot.floor ? "Floor located. " : "";
      if (this.candidate) {
        this.snapshot.message = this.candidateStable
          ? `${prefix}Look at the highlighted ${kind} and press the trigger to confirm it.`
          : `${prefix}Hold your gaze on the ${kind} until the marker turns green.`;
      } else {
        this.snapshot.message = `${prefix}Look down at the ${kind === "floor" ? "floor" : "tabletop"}. If no surface appears, use Scan room / Y and include the table in Quest Room Setup.`;
      }
    }
    this.drawGuides();
    return this.getSnapshot();
  }

  getSnapshot(): RoomSnapshot { return { ...this.snapshot }; }

  confirmCandidate(): boolean {
    if (!this.candidate || !this.candidateStable || this.session?.visibilityState !== "visible") return false;
    this.select(this.candidate.surface, this.candidate.plane);
    this.candidate = null;
    this.candidateStable = false;
    this.snapshot.ready = !!(this.snapshot.floor && this.snapshot.table);
    this.snapshot.message = this.snapshot.ready
      ? "Floor and table confirmed. Press the trigger again to begin."
      : "Floor confirmed. Look down at the tabletop and confirm it.";
    this.drawGuides();
    return true;
  }

  stop(): void {
    ++this.generation;
    this.session?.removeEventListener("end", this.onEnd);
    this.session?.removeEventListener("visibilitychange", this.onVisibility);
    this.space?.removeEventListener("reset", this.onReset);
    try { this.hitSource?.cancel(); } catch { /* Session may have ended already. */ }
    this.hitSource = null;
    this.session = null;
    this.space = null;
    this.clearSurfaces("Enter AR to scan the room.");
  }

  dispose(): void {
    this.stop();
    for (const outline of this.outlines) { outline.geometry.dispose(); outline.material.dispose(); }
    for (const marker of this.pointMarkers) marker.material.dispose();
    this.reticle.geometry.dispose();
    this.reticle.material.dispose();
    this.group.removeFromParent();
  }

  private readPlanes(frame: XRFrame, timeMs: number): void {
    const found = new Set<XRPlane>();
    for (const plane of frame.detectedPlanes ?? []) {
      const pose = frame.getPose(plane.planeSpace, this.space!);
      if (!pose || plane.orientation === "vertical") continue;
      const quaternion = new THREE.Quaternion().copy(pose.transform.orientation);
      if (!isHorizontal(quaternion)) continue;
      const matrix = new THREE.Matrix4().fromArray(pose.transform.matrix);
      const polygon = plane.polygon.map(point => new THREE.Vector3(point.x, point.y, point.z).applyMatrix4(matrix));
      const area = polygonAreaXZ(polygon);
      if (area < 0.04 || !polygon.every(point => Number.isFinite(point.x + point.y + point.z))) continue;
      const position = polygonCenter(polygon);
      const label = (plane.semanticLabel ?? "").toLowerCase().trim();
      const previous = this.records.get(plane);
      const stable = previous && position.distanceTo(previous.stablePosition) <= POSITION_TOLERANCE
        && quaternion.angleTo(previous.stableQuaternion) < 8 * Math.PI / 180
        && previous.label === label && Number.isFinite(previous.stableSince);
      this.records.set(plane, {
        plane, position, quaternion, polygon, label, area,
        stableSince: stable ? previous.stableSince : timeMs,
        stablePosition: stable ? previous.stablePosition : position.clone(),
        stableQuaternion: stable ? previous.stableQuaternion : quaternion.clone()
      });
      found.add(plane);
    }
    for (const plane of this.records.keys()) if (!found.has(plane)) this.records.delete(plane);
  }

  private refreshSelected(): void {
    for (const kind of ["floor", "table"] as const) {
      const plane = this.selected[kind];
      if (!plane) continue;
      const record = this.records.get(plane);
      const original = this.snapshot[kind];
      if (!record || (record.label && record.label !== kind)) {
        this.snapshot[kind] = null;
        this.selected[kind] = null;
      } else if (original) this.snapshot[kind] = this.surface(record, kind, original.source);
    }
    if (!this.snapshot.floor || (this.snapshot.table && !validTableHeight(this.snapshot.table.position.y, this.snapshot.floor.position.y))) {
      this.snapshot.table = null;
      this.selected.table = null;
    }
  }

  private accepts(kind: Surface["kind"], point: THREE.Vector3, viewer: THREE.Vector3, area: number): boolean {
    if (point.distanceTo(viewer) > 8 || !Number.isFinite(point.x + point.y + point.z)) return false;
    if (kind === "floor") return area >= 0.4 && viewer.y - point.y >= 0.65 && viewer.y - point.y <= 2.5;
    return area >= 0.09 && !!this.snapshot.floor && validTableHeight(point.y, this.snapshot.floor.position.y);
  }

  private surface(record: PlaneRecord, kind: Surface["kind"], source: Surface["source"]): Surface {
    return { kind, source, position: record.position.clone(), quaternion: record.quaternion.clone(), polygon: record.polygon.map(point => point.clone()) };
  }

  private readHitCandidate(frame: XRFrame, kind: Surface["kind"], viewer: THREE.Vector3): { surface: Surface; plane: null } | null {
    if (!this.hitSource || !frame.getHitTestResults) return null;
    try {
      for (const hit of frame.getHitTestResults(this.hitSource)) {
        const pose = hit.getPose(this.space!);
        if (!pose) continue;
        const position = new THREE.Vector3().copy(pose.transform.position);
        const quaternion = new THREE.Quaternion().copy(pose.transform.orientation);
        if (!isHorizontal(quaternion) || position.distanceTo(viewer) > 6 || position.distanceTo(viewer) < 0.25) continue;
        // A hit supplies one measured point, never an area estimate or semantic label.
        if (kind === "floor" && (viewer.y - position.y < 0.65 || viewer.y - position.y > 2.5)) continue;
        if (kind === "table" && (!this.snapshot.floor || !validTableHeight(position.y, this.snapshot.floor.position.y))) continue;
        return { surface: { kind, position, quaternion, polygon: [], source: "hit-test" }, plane: null };
      }
    } catch { /* Hit testing may be revoked independently of plane detection. */ }
    return null;
  }

  private updateCandidate(next: { surface: Surface; plane: XRPlane | null } | null, timeMs: number): void {
    if (!next) { this.candidate = null; this.candidateStable = false; return; }
    const same = this.candidate && this.candidate.plane === next.plane
      && this.candidate.surface.kind === next.surface.kind
      && this.candidate.surface.source === next.surface.source
      && this.candidate.anchor.distanceTo(next.surface.position) <= POSITION_TOLERANCE
      && this.candidate.surface.quaternion.angleTo(next.surface.quaternion) <= 8 * Math.PI / 180;
    this.candidate = {
      ...next, since: same ? this.candidate!.since : timeMs,
      anchor: same ? this.candidate!.anchor : next.surface.position.clone()
    };
    this.candidateStable = timeMs - this.candidate.since >= STABILITY_MS;
  }

  private select(surface: Surface, plane: XRPlane | null): void {
    this.snapshot[surface.kind] = surface;
    this.selected[surface.kind] = plane;
  }

  private clearSurfaces(message: string): void {
    this.records.clear();
    this.selected.floor = null;
    this.selected.table = null;
    this.snapshot = { floor: null, table: null, ready: false, message };
    this.candidate = null;
    this.candidateStable = false;
    this.lastFrameTime = -Infinity;
    this.clearGuides();
  }

  private makeOutline(color: number): THREE.LineLoop<THREE.BufferGeometry, THREE.LineBasicMaterial> {
    const outline = new THREE.LineLoop(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.85, depthTest: false }));
    outline.renderOrder = 14;
    return outline;
  }

  private drawGuides(): void {
    if (!this.group.visible) { this.clearGuides(); return; }
    const surfaces = [this.snapshot.floor, this.snapshot.table, this.candidate?.surface];
    surfaces.forEach((surface, index) => {
      const line = this.outlines[index];
      line.visible = !!surface && surface.polygon.length >= 3;
      if (line.visible && surface) {
        line.geometry.setFromPoints(surface.polygon.map(point => point.clone().add(new THREE.Vector3(0, 0.008, 0))));
        line.geometry.computeBoundingSphere();
      }
    });
    this.pointMarkers.forEach((marker, index) => {
      const surface = surfaces[index];
      marker.visible = !!surface && surface.polygon.length === 0;
      if (surface && marker.visible) {
        marker.position.copy(surface.position).add(new THREE.Vector3(0, 0.012, 0));
        marker.quaternion.copy(surface.quaternion);
      }
    });
    this.reticle.visible = !!this.candidate;
    if (this.candidate) {
      this.reticle.position.copy(this.candidate.surface.position).add(new THREE.Vector3(0, 0.012, 0));
      this.reticle.quaternion.copy(this.candidate.surface.quaternion);
      this.reticle.material.color.setHex(this.candidateStable ? 0x70e7ba : 0xffd278);
      this.outlines[2].material.color.copy(this.reticle.material.color);
    }
  }

  private clearGuides(): void {
    for (const outline of this.outlines) outline.visible = false;
    for (const marker of this.pointMarkers) marker.visible = false;
    this.reticle.visible = false;
  }
}
