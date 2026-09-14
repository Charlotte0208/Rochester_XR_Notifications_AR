import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { clone } from "three/examples/jsm/utils/SkeletonUtils.js";
import { createPlacementPlan, type DemonstrationPlacement, type PlacementPlan } from "./placement";
import { soundAppearance, variationAt } from "./sequence";
import { VariationCaption } from "./VariationCaption";

export { FEATURE_NAMES, TOTAL_SECONDS } from "./sequence";
export type { DemonstrationPlacement } from "./placement";

const MODEL_PATHS = [
  "/assets/notification-objects/uber_eats_delivery_bag.glb",
  "/assets/notification-objects/apple_focus_moon.glb"
] as const;
const BASE_SIZE = 0.28;

export type DemonstrationFrame = { label: string; objectCount: number };

export class Demonstration {
  readonly group = new THREE.Group();
  private readonly loader = new GLTFLoader();
  private readonly sources: THREE.Group[] = [];
  private readonly caption = new VariationCaption();
  private readonly captionPosition = new THREE.Vector3();
  private bag: THREE.Group | null = null;
  private moon: THREE.Group | null = null;
  private loadPromise: Promise<void> | null = null;
  private placement: DemonstrationPlacement = {
    floorY: 0,
    tablePosition: new THREE.Vector3(0, 0.75, -1.25),
    viewerPosition: new THREE.Vector3(0, 1.6, 0),
    forward: new THREE.Vector3(0, 0, -1)
  };
  private plan: PlacementPlan = createPlacementPlan(this.placement);
  private context: AudioContext | null = null;
  private panner: PannerNode | null = null;
  private readonly sounding = new Set<OscillatorNode>();
  private lastFeature = -1;
  private lastSeconds = -1;
  private lastSoundKey = "";
  private disposed = false;

  constructor() {
    this.group.name = "AR cue familiarization objects";
    this.group.visible = false;
    if (this.caption.sprite) this.group.add(this.caption.sprite);
  }

  async load(): Promise<void> {
    if (this.disposed) throw new Error("This demonstration has been disposed.");
    if (this.loadPromise) return this.loadPromise;
    this.loadPromise = this.loadModels();
    try {
      await this.loadPromise;
    } catch (error) {
      this.loadPromise = null;
      throw error;
    }
  }

  private async loadModels(): Promise<void> {
    const results = await Promise.allSettled(MODEL_PATHS.map((path) => this.loader.loadAsync(path)));
    const failure = results.find((result) => result.status === "rejected");
    if (failure || this.disposed) {
      results.forEach((result) => {
        if (result.status === "fulfilled") disposeModels([result.value.scene]);
      });
      throw new Error(failure?.status === "rejected"
        ? `Unable to load the required delivery bag or focus moon: ${String(failure.reason)}`
        : "The demonstration was closed while models were loading.");
    }
    results.forEach((result) => {
      if (result.status === "fulfilled") this.sources.push(result.value.scene);
    });
    this.bag = createNormalizedModel(this.sources[0], "Delivery bag");
    this.moon = createNormalizedModel(this.sources[1], "Focus moon");
    this.group.add(this.bag, this.moon);
  }

  setPlacement(input: DemonstrationPlacement): void {
    const placement = {
      floorY: input.floorY,
      tablePosition: input.tablePosition.clone(),
      viewerPosition: input.viewerPosition.clone(),
      forward: input.forward.clone(),
      floorPolygon: input.floorPolygon?.map((point) => point.clone()),
      tablePolygon: input.tablePolygon?.map((point) => point.clone())
    };
    const plan = createPlacementPlan(placement);
    this.placement = placement;
    this.plan = plan;
  }

  render(featureIndex: number, demoSeconds: number): DemonstrationFrame {
    if (!this.bag || !this.moon || this.disposed) return { label: "Loading required models", objectCount: 0 };
    if (featureIndex !== this.lastFeature || demoSeconds < this.lastSeconds) {
      this.stopAudio();
      this.lastSoundKey = "";
    }
    this.lastFeature = featureIndex;
    this.lastSeconds = demoSeconds;
    this.group.visible = true;
    this.bag.visible = true;
    this.moon.visible = false;
    this.place(this.bag, this.plan.middle, BASE_SIZE);
    let label = "";

    if (featureIndex === 0) {
      this.moon.visible = true;
      this.bag.position.addScaledVector(this.plan.right, -0.22);
      this.place(this.moon, this.plan.middle, BASE_SIZE);
      this.moon.position.addScaledVector(this.plan.right, 0.22);
      label = "Delivery bag and focus moon";
    } else if (featureIndex === 1) {
      const variation = variationAt(demoSeconds, 3);
      const sizes = [0.14, BASE_SIZE, 0.48];
      this.bag.scale.setScalar(sizes[variation.index]);
      label = `${["Small", "Medium", "Large"][variation.index]} · ${Math.round(sizes[variation.index] * 100)} cm (longest side)`;
    } else if (featureIndex === 2) {
      const variation = variationAt(demoSeconds, 5);
      const positions = [this.plan.near, this.plan.middle, this.plan.far, this.plan.tabletop, this.plan.floor];
      this.bag.position.copy(positions[variation.index]);
      if (variation.index < 3) {
        const distance = Math.hypot(
          this.bag.position.x - this.placement.viewerPosition.x,
          this.bag.position.z - this.placement.viewerPosition.z
        );
        label = `${["Near", "Mid-distance", "Far"][variation.index]} · ${distance.toFixed(2)} m horizontal`;
      } else {
        label = variation.index === 3 ? "On the identified table" : "On the identified floor";
      }
    } else if (featureIndex === 3) {
      const variation = variationAt(demoSeconds, 4);
      label = ["Still", "Slow floating movement", "Faster floating movement", "Approaching and moving away"][variation.index];
      if (variation.index === 1 || variation.index === 2) {
        // Same path and amplitude in both conditions; only speed changes.
        const period = variation.index === 1 ? 8 : 2.5;
        const phase = variation.seconds * Math.PI * 2 / period;
        this.bag.position.y += 0.075 * Math.sin(phase);
      } else if (variation.index === 3) {
        // Start at mid-distance; remain inside the same measured near/far interval.
        const mix = 0.5 - 0.5 * Math.sin(variation.seconds * Math.PI * 2 / 9);
        this.bag.position.lerpVectors(this.plan.near, this.plan.far, mix);
      }
    } else if (featureIndex === 4) {
      const variation = variationAt(demoSeconds, 3);
      const appearance = soundAppearance(variation.seconds);
      this.bag.visible = appearance.visible;
      label = ["Silent", "One subtle chime", "Repeated subtle chimes"][variation.index];
      const soundKey = `${variation.index}:${appearance.cycle}`;
      const audible = appearance.visible && (variation.index === 2 || (variation.index === 1 && appearance.cycle === 0));
      if (soundKey !== this.lastSoundKey) {
        this.lastSoundKey = soundKey;
        if (audible) this.playChime(this.bag.position);
      }
    } else {
      this.hide();
    }
    // Size and motion keep the caption anchored, so it introduces no extra movement.
    this.captionPosition.copy(featureIndex === 1 || featureIndex === 3 ? this.plan.middle : this.bag.position);
    this.captionPosition.y += featureIndex === 1 ? 0.59 : 0.43;
    this.caption.update(label, this.captionPosition,
      this.group.visible && featureIndex > 0 && this.bag.visible);
    return { label, objectCount: this.group.visible ? Number(this.bag.visible) + Number(this.moon.visible) : 0 };
  }

  /** World-space centre for desktop framing; measured placements remain unchanged. */
  getFocusPoint(target: THREE.Vector3): THREE.Vector3 {
    if (!this.bag) {
      target.copy(this.plan.middle);
      target.y += BASE_SIZE / 2;
    } else {
      target.copy(this.bag.position);
      target.y += (this.bag.userData.normalizedHeight ?? 1) * this.bag.scale.y / 2;
      if (this.bag.visible && this.moon?.visible) {
        target.add(this.moon.position).multiplyScalar(0.5);
        target.y += (this.moon.userData.normalizedHeight ?? 1) * this.moon.scale.y / 4;
      }
    }
    return this.group.localToWorld(target);
  }

  private place(model: THREE.Group, position: THREE.Vector3, size: number): void {
    model.position.copy(position);
    model.rotation.set(0, this.plan.yaw, 0);
    model.scale.setScalar(size);
  }

  hide(): void {
    this.group.visible = false;
    this.caption.hide();
    this.stopAudio();
    this.lastFeature = -1;
    this.lastSeconds = -1;
    this.lastSoundKey = "";
  }

  /** Must be called from the desktop Start or XR select user gesture. */
  async unlockAudio(): Promise<void> {
    if (this.disposed) return;
    if (!this.context) {
      this.context = new AudioContext();
      this.panner = this.context.createPanner();
      this.panner.panningModel = "HRTF";
      this.panner.distanceModel = "inverse";
      this.panner.refDistance = 1;
      this.panner.maxDistance = 8;
      this.panner.rolloffFactor = 0.5;
      this.panner.connect(this.context.destination);
    }
    if (this.context.state === "suspended") await this.context.resume();
    if (this.context.state !== "running") throw new Error("Audio is paused by the browser. Select Start again to enable the sound demonstration.");
  }

  updateListener(position: THREE.Vector3, quaternion: THREE.Quaternion): void {
    if (!this.context) return;
    const listener = this.context.listener;
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(quaternion);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(quaternion);
    if (listener.positionX) {
      listener.positionX.value = position.x;
      listener.positionY.value = position.y;
      listener.positionZ.value = position.z;
      listener.forwardX.value = forward.x;
      listener.forwardY.value = forward.y;
      listener.forwardZ.value = forward.z;
      listener.upX.value = up.x;
      listener.upY.value = up.y;
      listener.upZ.value = up.z;
    } else {
      listener.setPosition(position.x, position.y, position.z);
      listener.setOrientation(forward.x, forward.y, forward.z, up.x, up.y, up.z);
    }
  }

  private playChime(position: THREE.Vector3): void {
    if (!this.context || !this.panner || this.context.state !== "running") return;
    this.panner.positionX.value = position.x;
    this.panner.positionY.value = position.y + BASE_SIZE / 2;
    this.panner.positionZ.value = position.z;
    const now = this.context.currentTime;
    for (const [frequency, delay, volume] of [[660, 0, 0.05], [880, 0.1, 0.028]]) {
      const oscillator = this.context.createOscillator();
      const envelope = this.context.createGain();
      oscillator.type = "sine";
      oscillator.frequency.value = frequency;
      envelope.gain.setValueAtTime(0, now + delay);
      envelope.gain.linearRampToValueAtTime(volume, now + delay + 0.018);
      envelope.gain.exponentialRampToValueAtTime(0.0001, now + delay + 0.42);
      oscillator.connect(envelope);
      envelope.connect(this.panner);
      this.sounding.add(oscillator);
      oscillator.onended = () => {
        this.sounding.delete(oscillator);
        oscillator.disconnect();
        envelope.disconnect();
      };
      oscillator.start(now + delay);
      oscillator.stop(now + delay + 0.45);
    }
  }

  /** Stop audible nodes without replaying an already delivered cue after pause/resume. */
  stopAudio(): void {
    this.sounding.forEach((oscillator) => {
      try { oscillator.stop(); } catch { /* Already stopped by its envelope. */ }
    });
    this.sounding.clear();
  }

  dispose(): void {
    this.disposed = true;
    this.hide();
    this.group.removeFromParent();
    this.group.clear();
    this.caption.dispose();
    disposeModels(this.sources);
    this.sources.length = 0;
    this.bag = null;
    this.moon = null;
    this.panner?.disconnect();
    if (this.context && this.context.state !== "closed") void this.context.close().catch(() => {});
  }
}

function createNormalizedModel(source: THREE.Group, name: string): THREE.Group {
  const model = new THREE.Group();
  model.name = name;
  const content = clone(source);
  content.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(content);
  const size = box.getSize(new THREE.Vector3());
  const maximum = Math.max(size.x, size.y, size.z);
  if (!Number.isFinite(maximum) || maximum <= 0) throw new Error(`The ${name} model has no usable geometry.`);
  const centre = box.getCenter(new THREE.Vector3());
  model.userData.normalizedHeight = size.y / maximum;
  const normalization = new THREE.Group();
  normalization.scale.setScalar(1 / maximum);
  normalization.position.set(-centre.x / maximum, -box.min.y / maximum, -centre.z / maximum);
  normalization.add(content);
  model.add(normalization);
  return model;
}

function disposeModels(models: THREE.Object3D[]): void {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  models.forEach((model) => model.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    geometries.add(mesh.geometry);
    (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).forEach((material) => {
      materials.add(material);
      Object.values(material).forEach((value) => {
        if (value && (value as THREE.Texture).isTexture) textures.add(value as THREE.Texture);
      });
    });
  }));
  geometries.forEach((geometry) => geometry.dispose());
  materials.forEach((material) => material.dispose());
  textures.forEach((texture) => {
    const bitmap = texture.source?.data as { close?: () => void } | undefined;
    bitmap?.close?.();
    texture.dispose();
  });
}
