import type { WebGLRenderer } from "three";

export interface SessionCallbacks {
  onStart(session: XRSession, space: XRReferenceSpace): Promise<void>;
  onEnd(): void;
  onStatus(message: string): void;
  unlockAudio(): void;
}

export class ARSession {
  session: XRSession | null = null;
  space: XRReferenceSpace | null = null;
  private busy = false;

  constructor(private renderer: WebGLRenderer, private button: HTMLButtonElement, private callbacks: SessionCallbacks) {
    button.addEventListener("click", () => { if (this.session) void this.end(); else void this.enter(); });
  }

  async check(): Promise<void> {
    this.button.disabled = true;
    this.button.textContent = "Checking AR support…";
    this.callbacks.onStatus("Models ready. Checking passthrough availability…");
    try {
      if (!window.isSecureContext) throw new Error("Open this page over HTTPS to enter AR on Quest 3.");
      if (!navigator.xr || !await navigator.xr.isSessionSupported("immersive-ar")) {
        throw new Error("Open this page in Meta Quest Browser for passthrough AR. Desktop preview is available here.");
      }
      this.button.textContent = "Enter passthrough AR";
      this.button.disabled = false;
      this.callbacks.onStatus("Ready for Meta Quest 3. Allow access to your room when prompted.");
    } catch (error) {
      this.button.textContent = "Quest Browser required";
      this.callbacks.onStatus(message(error));
    }
  }

  async enter(): Promise<void> {
    if (this.busy || this.session || !navigator.xr) return;
    this.busy = true;
    this.button.disabled = true;
    // Both calls are initiated from the browser click's user activation.
    this.callbacks.unlockAudio();
    let session: XRSession | null = null;
    try {
      session = await navigator.xr.requestSession("immersive-ar", {
        optionalFeatures: ["local-floor", "plane-detection", "hit-test"],
      });
      this.session = session;
      session.addEventListener("end", this.ended, { once: true });
      let type: XRReferenceSpaceType = "local-floor";
      try { await session.requestReferenceSpace(type); }
      catch { type = "local"; await session.requestReferenceSpace(type); }
      if (this.session !== session) return;
      this.renderer.xr.setReferenceSpaceType(type);
      await this.renderer.xr.setSession(session);
      if (this.session !== session) return;
      this.space = this.renderer.xr.getReferenceSpace();
      if (!this.space) throw new Error("The browser did not provide a tracked reference space.");
      await this.callbacks.onStart(session, this.space);
      if (this.session !== session) return;
      this.button.textContent = "Exit AR";
    } catch (error) {
      if (session && this.session === session) {
        try { await session.end(); } catch { this.ended(); }
      }
      this.callbacks.onStatus(`Could not enter AR: ${message(error)}. Allow room access and try again.`);
      this.button.textContent = "Try entering AR again";
    } finally {
      this.busy = false;
      this.button.disabled = false;
    }
  }

  async captureRoom(): Promise<void> {
    const session = this.session as (XRSession & { initiateRoomCapture?: () => Promise<void> }) | null;
    if (!session) return;
    if (!session.initiateRoomCapture) {
      throw new Error("Room scan is unavailable here. Exit AR, complete Space Setup in Quest settings, include your table, then re-enter.");
    }
    await session.initiateRoomCapture();
  }

  async end(): Promise<void> {
    try { await this.session?.end(); }
    catch (error) { this.callbacks.onStatus(`Could not exit AR: ${message(error)}`); }
  }

  private ended = (): void => {
    this.session = null;
    this.space = null;
    this.busy = false;
    this.button.disabled = false;
    this.button.textContent = "Enter passthrough AR";
    this.callbacks.onEnd();
  };
}

function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
