/** Five one-minute features. The title is included in each minute. */
export const FEATURE_NAMES = [
  "1. Two types of objects",
  "2. Size",
  "3. Distance and placement",
  "4. Motion",
  "5. Sound"
] as const;

export const INTRO_SECONDS = 3;
export const FEATURE_SECONDS = 60;
export const DEMONSTRATION_SECONDS = FEATURE_SECONDS - INTRO_SECONDS;
export const TOTAL_SECONDS = FEATURE_NAMES.length * FEATURE_SECONDS;

export type TimelineState = {
  featureIndex: number;
  featureSeconds: number;
  demoSeconds: number;
  phase: "intro" | "demonstration" | "complete";
};

export function getTimelineState(elapsedSeconds: number): TimelineState {
  const elapsed = Number.isFinite(elapsedSeconds)
    ? Math.min(TOTAL_SECONDS, Math.max(0, elapsedSeconds))
    : 0;
  if (elapsed >= TOTAL_SECONDS) {
    return {
      featureIndex: FEATURE_NAMES.length - 1,
      featureSeconds: FEATURE_SECONDS,
      demoSeconds: DEMONSTRATION_SECONDS,
      phase: "complete"
    };
  }
  const featureIndex = Math.floor(elapsed / FEATURE_SECONDS);
  const featureSeconds = elapsed - featureIndex * FEATURE_SECONDS;
  return {
    featureIndex,
    featureSeconds,
    demoSeconds: Math.max(0, featureSeconds - INTRO_SECONDS),
    phase: featureSeconds < INTRO_SECONDS ? "intro" : "demonstration"
  };
}

/** Equal-length variations keep the demonstration independent of frame rate. */
export function variationAt(demoSeconds: number, count: number): { index: number; seconds: number } {
  const duration = DEMONSTRATION_SECONDS / count;
  const time = Math.max(0, Math.min(DEMONSTRATION_SECONDS - 1e-6, demoSeconds));
  const index = Math.floor(time / duration);
  return { index, seconds: time - index * duration };
}

/** Identical appearance timing in all sound conditions isolates the sound change. */
export function soundAppearance(seconds: number): { visible: boolean; cycle: number } {
  const cycle = Math.floor(Math.max(0, seconds) / 7.5);
  return { visible: seconds - cycle * 7.5 < 6, cycle };
}
