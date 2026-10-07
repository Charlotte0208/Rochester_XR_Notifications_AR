import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { clone } from "three/examples/jsm/utils/SkeletonUtils.js";
import { createPlacementPlan, type DemonstrationPlacement, type ModelFootprints, type PlacementPlan } from "./placement";
import { DEMONSTRATION_SECONDS, OBJECT_SIZES, soundAppearance, variationAt } from "./sequence";
import { VariationCaption } from "./VariationCaption";

export { FEATURE_NAMES, TOTAL_SECONDS } from "./sequence";
export type { DemonstrationPlacement } from "./placement";

const MODEL_PATHS = [
  "/assets/notification-objects/uber_eats_delivery_bag.glb",
  "/assets/notification-objects/apple_focus_moon.glb"
] as const;
const BASE_SIZE = OBJECT_SIZES[1];

export type DemonstrationFrame = { label: string; objectCount: number };

export class Demonstration {
  readonly group = new THREE.Group();
  private readonly loader = new GLTFLoader();
  private readonly sources: THREE.Group[] = [];
  private readonly caption = new VariationCaption();
  private readonly captionPosition = new THREE.Vector3();
  private readonly audioPosition = new THREE.Vector3();
  private bag: THREE.Group | null = null;
  private moon: THREE.Group | null = null;
  private loadPromise: Promise<void> | null = null;
  private placement: DemonstrationPlacement | null = null;
  private plan: PlacementPlan | null = null;
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
    try {
      this.bag = createNormalizedModel(this.sources[0], "Delivery bag");
      this.moon = createNormalizedModel(this.sources[1], "Focus moon");
      this.group.add(this.bag, this.moon);
      if (this.placement) this.plan = createPlacementPlan(this.placement, this.modelFootprints());
    } catch (error) {
      this.bag?.removeFromParent();
      this.moon?.removeFromParent();
      this.bag = this.moon = null;
      disposeModels(this.sources);
      this.sources.length = 0;
      throw error;
    }
  }

  setPlacement(input: DemonstrationPlacement): void {
    const placement = {
      tablePosition: input.tablePosition.clone(),
      tableQuaternion: input.tableQuaternion?.clone(),
      viewerPosition: input.viewerPosition.clone(),
      forward: input.forward.clone(),
      tablePolygon: input.tablePolygon?.map((point) => point.clone())
    };
    const plan = createPlacementPlan(placement, this.modelFootprints());
    this.placement = placement;
    this.plan = plan;
  }

  private modelFootprints(): ModelFootprints {
    return {
      bag: this.bag?.userData.normalizedFootprint ?? { width: 1, depth: 1 },
      moon: this.moon?.userData.normalizedFootprint ?? { width: 1, depth: 1 }
    };
  }

  render(featureIndex: number, demoSeconds: number): DemonstrationFrame {
    const plan = this.plan;
    if (!plan) {
      this.hide();
      return { label: "Waiting for a scanned table", objectCount: 0 };
    }
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
    this.place(this.bag, plan.middle, BASE_SIZE * plan.scale);
    let label = "";

    if (featureIndex === 0) {
      this.moon.visible = true;
      this.bag.position.addScaledVector(plan.right, -plan.pairOffset);
      this.place(this.moon, plan.middle, BASE_SIZE * plan.scale);
      this.moon.position.addScaledVector(plan.right, plan.pairOffset);
      label = "Delivery bag and focus moon";
    } else if (featureIndex === 1) {
      const variation = variationAt(demoSeconds, 3);
      const sizes = OBJECT_SIZES.map(size => size * plan.scale);
      this.bag.scale.setScalar(sizes[variation.index]);
      label = ["Small", "Medium", "Large"][variation.index];
    } else if (featureIndex === 2) {
      const variation = variationAt(demoSeconds, 3);
      const positions = [plan.near, plan.distanceMiddle, plan.far];
      this.bag.position.copy(positions[variation.index]);
      label = `${["Near", "Middle", "Far"][variation.index]} position on the table`;
    } else if (featureIndex === 3) {
      const variation = variationAt(demoSeconds, 4);
      label = ["Still", "Slow floating movement", "Faster floating movement", "Approaching and moving away"][variation.index];
      if (variation.index === 1 || variation.index === 2) {
        // Same path and amplitude in both conditions; only speed changes.
        const period = variation.index === 1 ? 4 : 1.2;
        const phase = variation.seconds * Math.PI * 2 / period;
        this.bag.position.addScaledVector(plan.up, 0.075 * plan.scale * (1 - Math.cos(phase)));
      } else if (variation.index === 3) {
        // One arrival, a brief landing, then one departure. Never wrap or oscillate.
        const progress = THREE.MathUtils.clamp(variation.seconds / (DEMONSTRATION_SECONDS / 4), 0, 1);
        if (progress < 0.45) {
          const t = THREE.MathUtils.smoothstep(progress / 0.45, 0, 1);
          plan.arrival.getPoint(t, this.bag.position);
        } else if (progress <= 0.55) {
          this.bag.position.copy(plan.middle);
        } else {
          const t = THREE.MathUtils.smoothstep((progress - 0.55) / 0.45, 0, 1);
          plan.departure.getPoint(t, this.bag.position);
        }
      }
    } else if (featureIndex === 4) {
      const variation = variationAt(demoSeconds, 3);
      const appearance = soundAppearance(variation.seconds, variation.index);
      this.bag.visible = appearance.visible;
      label = ["no sound", "quick sound", "repetitive sound"][variation.index];
      const soundKey = `${variation.index}:${appearance.cycle}`;
      const audible = appearance.visible && (variation.index === 2 || (variation.index === 1 && appearance.cycle === 0));
      if (soundKey !== this.lastSoundKey) {
        this.lastSoundKey = soundKey;
        if (audible) this.playChime();
      }
    } else {
      this.hide();
    }
    // Size and motion keep the caption anchored, so it introduces no extra movement.
    this.captionPosition.copy(featureIndex === 1 || featureIndex === 3 ? plan.middle : this.bag.position);
    this.captionPosition.addScaledVector(plan.up, (featureIndex === 1 ? OBJECT_SIZES[2] : 0.43) * plan.scale + 0.11);
    this.caption.update(label, this.captionPosition,
      this.group.visible && featureIndex > 0 && (featureIndex === 4 || this.bag.visible));
    return { label, objectCount: this.group.visible ? Number(this.bag.visible) + Number(this.moon.visible) : 0 };
  }

  /** World-space cue centre for spatial sound, available after a table is supplied. */
  getFocusPoint(target: THREE.Vector3): THREE.Vector3 {
    const plan = this.plan;
    if (!plan) return target;
    if (!this.bag) {
      target.copy(plan.middle);
      target.addScaledVector(plan.up, BASE_SIZE * plan.scale / 2);
    } else {
      target.copy(this.bag.position);
      target.addScaledVector(plan.up, (this.bag.userData.normalizedHeight ?? 1) * this.bag.scale.y / 2);
      if (this.bag.visible && this.moon?.visible) {
        target.add(this.moon.position).multiplyScalar(0.5);
        target.addScaledVector(plan.up, (this.moon.userData.normalizedHeight ?? 1) * this.moon.scale.y / 4);
      }
    }
    return this.group.localToWorld(target);
  }

  private place(model: THREE.Group, position: THREE.Vector3, size: number): void {
    if (!this.plan) return;
    model.position.copy(position);
    model.quaternion.copy(this.plan.rotation);
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

  /** Call from the Enter AR user gesture. */
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

  private playChime(): void {
    if (!this.context || !this.panner || this.context.state !== "running") return;
    const position = this.getFocusPoint(this.audioPosition);
    this.panner.positionX.value = position.x;
    this.panner.positionY.value = position.y;
    this.panner.positionZ.value = position.z;
    const now = this.context.currentTime;
    for (const [frequency, delay, volume] of [[660, 0, 0.05], [880, 0.07, 0.028]]) {
      const oscillator = this.context.createOscillator();
      const envelope = this.context.createGain();
      oscillator.type = "sine";
      oscillator.frequency.value = frequency;
      envelope.gain.setValueAtTime(0, now + delay);
      envelope.gain.linearRampToValueAtTime(volume, now + delay + 0.018);
      envelope.gain.exponentialRampToValueAtTime(0.0001, now + delay + 0.22);
      oscillator.connect(envelope);
      envelope.connect(this.panner);
      this.sounding.add(oscillator);
      oscillator.onended = () => {
        this.sounding.delete(oscillator);
        oscillator.disconnect();
        envelope.disconnect();
      };
      oscillator.start(now + delay);
      oscillator.stop(now + delay + 0.24);
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
  model.userData.normalizedFootprint = { width: size.x / maximum, depth: size.z / maximum };
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
