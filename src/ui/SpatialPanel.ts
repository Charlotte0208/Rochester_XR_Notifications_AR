import * as THREE from "three";

/** Canvas text in the XR scene, so it works without DOM-overlay support. */
export class SpatialPanel {
  readonly mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  private readonly canvas = document.createElement("canvas");
  private readonly context: CanvasRenderingContext2D;
  private texture: THREE.CanvasTexture;
  private key = "";
  private mode: "title" | "status" = "status";
  private title = "";

  constructor() {
    this.canvas.width = 1536;
    this.canvas.height = 960;
    this.context = this.canvas.getContext("2d")!;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({
      map: this.texture, transparent: true, depthTest: false, depthWrite: false, toneMapped: false,
    }));
    this.mesh.renderOrder = 100;
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    this.mesh.name = "Spatial instruction canvas";
  }

  show(title: string, mode: "title" | "status" = "status"): void {
    this.mesh.visible = true;
    this.mode = mode;
    this.title = title;
    const key = `${mode}|${title}|${this.canvas.height}`;
    if (key === this.key) return;
    this.key = key;
    const c = this.context;
    const w = this.canvas.width, h = this.canvas.height;
    c.clearRect(0, 0, w, h);
    c.fillStyle = "rgba(255,255,255,0.82)";
    c.beginPath(); c.roundRect(0, 0, w, h, 46); c.fill();
    c.textAlign = "center";
    c.textBaseline = "middle";
    c.fillStyle = "#172932";
    let size = Math.min(mode === "title" ? 190 : 220, h * 0.36);
    let lines: string[] = [];
    while (size >= 24) {
      c.font = `600 ${size}px system-ui, sans-serif`;
      lines = [];
      for (const paragraph of title.split("\n")) {
        let line = "";
        for (const word of paragraph.split(" ")) {
          const next = line ? `${line} ${word}` : word;
          if (c.measureText(next).width > w - 150 && line) { lines.push(line); line = word; }
          else line = next;
        }
        lines.push(line);
      }
      if (lines.length * size * 1.2 <= h * 0.78
        && lines.every(line => c.measureText(line).width <= w - 150)) break;
      size -= 2;
    }
    const lineHeight = size * 1.2;
    lines.forEach((line, i) => c.fillText(line, w / 2, h / 2 + (i - (lines.length - 1) / 2) * lineHeight));
    this.texture.needsUpdate = true;
  }

  hide(): void { this.mesh.visible = false; }

  follow(position: THREE.Vector3, orientation: THREE.Quaternion, projection: ArrayLike<number>): void {
    if (!this.mesh.visible) return;
    const distance = 1.4;
    // Status panels retain their area. Category titles now occupy half of their last area.
    // Use the actual XR eye projection, never a hard-coded Quest FOV.
    const width = 2 * distance / Math.abs(projection[0] || 1);
    const height = 2 * distance / Math.abs(projection[5] || 1);
    if (this.mode === "title") {
      this.mesh.scale.set(width * 0.8, height * 0.5, 1);
      this.mesh.position.set(0, 0, -distance);
    } else {
      const panelWidth = Math.min(width * 0.68, 1.25);
      this.mesh.scale.set(panelWidth, panelWidth / 2.5, 1);
      this.mesh.position.set(0, 0, -distance);
    }
    const areaScale = Math.sqrt(this.mode === "title" ? 1 / 6 : 1 / 3);
    this.mesh.scale.x *= areaScale;
    this.mesh.scale.y *= areaScale;
    this.mesh.position.applyQuaternion(orientation).add(position);
    this.mesh.quaternion.copy(orientation);
    // Match canvas and plane aspect ratios so text is never stretched in either eye.
    const canvasHeight = Math.max(256, Math.round(this.canvas.width * this.mesh.scale.y / this.mesh.scale.x / 8) * 8);
    if (Math.abs(canvasHeight - this.canvas.height) >= 8) {
      this.canvas.height = canvasHeight;
      this.texture.dispose();
      this.texture = new THREE.CanvasTexture(this.canvas);
      this.texture.colorSpace = THREE.SRGBColorSpace;
      this.mesh.material.map = this.texture;
      this.show(this.title, this.mode);
    }
  }

  dispose(): void { this.texture.dispose(); this.mesh.geometry.dispose(); this.mesh.material.dispose(); }
}
