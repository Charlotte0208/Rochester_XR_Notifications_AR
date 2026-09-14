import * as THREE from "three";

/** Small text floating with the example; the background stays fully transparent. */
export class VariationCaption {
  readonly sprite: THREE.Sprite | null = null;
  private readonly context: CanvasRenderingContext2D | null = null;
  private readonly texture: THREE.CanvasTexture | null = null;
  private lastText = "";

  constructor() {
    // The deterministic demonstration can also be exercised without a browser/GPU.
    if (typeof document === "undefined") return;
    const canvas = document.createElement("canvas");
    canvas.width = 768;
    canvas.height = 96;
    this.context = canvas.getContext("2d");
    if (!this.context) throw new Error("The browser could not create the variation caption.");
    this.texture = new THREE.CanvasTexture(canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    const material = new THREE.SpriteMaterial({
      map: this.texture,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      toneMapped: false
    });
    this.sprite = new THREE.Sprite(material);
    this.sprite.name = "Current variation caption";
    this.sprite.scale.set(0.78, 0.0975, 1);
    this.sprite.renderOrder = 90;
    this.sprite.visible = false;
  }

  update(text: string, position: THREE.Vector3, visible: boolean): void {
    if (!this.sprite || !this.context || !this.texture) return;
    this.sprite.visible = visible && text.length > 0;
    if (!this.sprite.visible) return;
    this.sprite.position.copy(position);
    if (text === this.lastText) return;
    this.lastText = text;
    const context = this.context;
    context.clearRect(0, 0, 768, 96);
    context.font = "600 40px system-ui, sans-serif";
    context.textAlign = "center";
    context.textBaseline = "middle";
    // A narrow dark outline keeps plain white lettering legible over passthrough.
    context.lineJoin = "round";
    context.lineWidth = 5;
    context.strokeStyle = "rgba(15, 23, 32, 0.9)";
    context.fillStyle = "rgba(255, 255, 255, 0.96)";
    context.strokeText(text, 384, 48, 736);
    context.fillText(text, 384, 48, 736);
    this.texture.needsUpdate = true;
  }

  hide(): void {
    if (this.sprite) this.sprite.visible = false;
  }

  dispose(): void {
    this.sprite?.removeFromParent();
    this.texture?.dispose();
    this.sprite?.material.dispose();
    // THREE.Sprite geometry is shared globally; only the owned material/map are freed.
  }
}
