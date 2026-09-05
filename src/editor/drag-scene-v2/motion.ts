import { copyRect, isFiniteSceneRect } from "./geometry";
import type {
  SceneMotionSample,
  SceneRect,
  SceneVelocity,
} from "./types";

export interface SceneClock {
  now(): number;
  requestFrame(callback: (timeMs: number) => void): number;
  cancelFrame(frameId: number): void;
}

export function createBrowserSceneClock(ownerWindow: Window): SceneClock {
  return {
    now: () => ownerWindow.performance.now(),
    requestFrame: (callback) => ownerWindow.requestAnimationFrame(callback),
    cancelFrame: (frameId) => ownerWindow.cancelAnimationFrame(frameId),
  };
}

export interface SceneFallbackScheduler {
  request(callback: () => void, delayMs: number): number;
  cancel(id: number): void;
}

/**
 * Delivers one scene sample from the first available browser wakeup.
 *
 * requestAnimationFrame remains the foreground presentation driver. The
 * fallback does not advance a second clock or integrate motion; it merely
 * samples the same absolute SceneClock when Chromium throttles rendering.
 */
export class SceneFrameScheduler {
  private frameId = 0;
  private fallbackId = 0;
  private generation = 0;

  constructor(
    private readonly clock: SceneClock,
    private readonly fallback: SceneFallbackScheduler,
    private readonly fallbackDelayMs = 50,
  ) {}

  request(callback: (timeMs: number) => void): void {
    this.cancel();
    const generation = this.generation;
    let delivered = false;
    const deliver = (timeMs: number): void => {
      if (delivered || generation !== this.generation) return;
      delivered = true;
      const frameId = this.frameId;
      const fallbackId = this.fallbackId;
      this.frameId = 0;
      this.fallbackId = 0;
      if (frameId) this.clock.cancelFrame(frameId);
      if (fallbackId) this.fallback.cancel(fallbackId);
      callback(timeMs);
    };
    this.frameId = this.clock.requestFrame(deliver);
    this.fallbackId = this.fallback.request(
      () => deliver(this.clock.now()),
      this.fallbackDelayMs,
    );
  }

  cancel(): void {
    this.generation += 1;
    if (this.frameId) this.clock.cancelFrame(this.frameId);
    if (this.fallbackId) this.fallback.cancel(this.fallbackId);
    this.frameId = 0;
    this.fallbackId = 0;
  }
}

export function createBrowserSceneFrameScheduler(
  ownerWindow: Window,
  clock: SceneClock,
): SceneFrameScheduler {
  return new SceneFrameScheduler(clock, {
    request: (callback, delayMs) => ownerWindow.setTimeout(callback, delayMs),
    cancel: (id) => ownerWindow.clearTimeout(id),
  });
}

export interface SceneMotionConfig {
  /** Critical-damping angular frequency in inverse seconds. */
  omega: number;
  /** Maximum edge error, in CSS pixels, at which an endpoint may snap. */
  positionTolerance: number;
  /** Maximum edge velocity, in CSS pixels per second, at endpoint snap. */
  velocityTolerance: number;
  /** Optional shared scene duration. When present, live reflow uses the
   * configured cubic-bezier instead of the damping curve used by ghost size. */
  sceneDurationMs?: number;
  /** CSS cubic-bezier control points [x1, y1, x2, y2]. */
  sceneEasing?: readonly [number, number, number, number];
}

export interface SceneMotionRetargetOptions<Key = never> {
  sceneDurationMs?: number;
  sceneEasing?: readonly [number, number, number, number];
  /** Rebase an in-flight curve even when its numerical endpoint is unchanged. */
  restartOnEqualTarget?: boolean;
  /** Keys whose new endpoint must be painted on the first retargeted frame
   * while the rest of the scene retains its continuous motion. */
  snapKeys?: ReadonlySet<Key>;
}

type ScalarSample = { value: number; velocity: number; settled: boolean };

type ProgressMotion = {
  sample(timeMs: number): ScalarSample;
};

function cubicBezierCoordinate(t: number, first: number, second: number): number {
  const inverse = 1 - t;
  return 3 * inverse * inverse * t * first +
    3 * inverse * t * t * second + t * t * t;
}

function cubicBezierDerivative(t: number, first: number, second: number): number {
  const inverse = 1 - t;
  return 3 * inverse * inverse * first +
    6 * inverse * t * (second - first) +
    3 * t * t * (1 - second);
}

/**
 * Deterministic CSS cubic-bezier progress evaluated on one scene clock.
 *
 * Solving x(t)=elapsed uses a bounded Newton pass with bisection fallback, so
 * sampling is refresh-rate independent and reproduces the legacy WAAPI curve
 * without giving individual blocks independent animation timelines.
 */
class CubicBezierProgressMotion implements ProgressMotion {
  constructor(
    private readonly startTimeMs: number,
    private readonly durationMs: number,
    private readonly easing: readonly [number, number, number, number],
  ) {}

  sample(timeMs: number): ScalarSample {
    const durationMs = Math.max(1, this.durationMs);
    const elapsed = Math.max(0, timeMs - this.startTimeMs);
    if (elapsed >= durationMs) return { value: 1, velocity: 0, settled: true };
    const x = elapsed / durationMs;
    const [x1, y1, x2, y2] = this.easing;
    let low = 0;
    let high = 1;
    let parameter = x;
    for (let iteration = 0; iteration < 8; iteration++) {
      const error = cubicBezierCoordinate(parameter, x1, x2) - x;
      if (Math.abs(error) < 1e-9) break;
      if (error < 0) low = parameter;
      else high = parameter;
      const slope = cubicBezierDerivative(parameter, x1, x2);
      const next = Math.abs(slope) < 1e-7 ? Number.NaN : parameter - error / slope;
      parameter = Number.isFinite(next) && next > low && next < high
        ? next
        : (low + high) / 2;
    }
    const value = cubicBezierCoordinate(parameter, y1, y2);
    const dx = cubicBezierDerivative(parameter, x1, x2);
    const dy = cubicBezierDerivative(parameter, y1, y2);
    const velocity = Math.abs(dx) < 1e-7 ? 0 : (dy / dx) * (1000 / durationMs);
    return { value, velocity, settled: false };
  }
}

/**
 * Closed-form critically damped scalar motion.
 *
 * x(t) = target + (A + B t)e^(-omega t)
 *
 * Retargeting samples the prior curve at the exact retarget time. Velocity is
 * preserved only while it points toward the new endpoint and cannot carry the
 * edge past that endpoint. Wrong-way velocity is clamped to zero; excessive
 * toward-target velocity is capped at omega * remainingDistance. That bound
 * keeps the closed-form curve inside the interval between its presented value
 * and endpoint for all future time, so retargeting cannot bounce or vibrate.
 * The result is refresh-rate independent and position-continuous.
 */
export class DampedScalarMotion {
  private startValue: number;
  private startVelocity = 0;
  private targetValue: number;
  private startTimeMs: number;
  private isSettled = true;

  constructor(
    value: number,
    startTimeMs: number,
    private readonly config: SceneMotionConfig,
  ) {
    this.startValue = value;
    this.targetValue = value;
    this.startTimeMs = startTimeMs;
  }

  target(): number {
    return this.targetValue;
  }

  sample(timeMs: number): ScalarSample {
    if (this.isSettled) {
      return { value: this.targetValue, velocity: 0, settled: true };
    }
    const elapsedSeconds = Math.max(0, timeMs - this.startTimeMs) / 1000;
    const omega = Math.max(0.001, this.config.omega);
    const a = this.startValue - this.targetValue;
    const b = this.startVelocity + omega * a;
    const decay = Math.exp(-omega * elapsedSeconds);
    const value = this.targetValue + (a + b * elapsedSeconds) * decay;
    const velocity = (b - omega * (a + b * elapsedSeconds)) * decay;
    const settled = Math.abs(value - this.targetValue) <= this.config.positionTolerance &&
      Math.abs(velocity) <= this.config.velocityTolerance;
    if (settled) {
      this.isSettled = true;
      return { value: this.targetValue, velocity: 0, settled: true };
    }
    return { value, velocity, settled: false };
  }

  retarget(target: number, timeMs: number, incomingVelocity?: number): void {
    if (!Number.isFinite(target)) throw new Error("Scene motion target must be finite");
    // The closed-form curve already owns this endpoint. Re-seeding an
    // unchanged axis is mathematically redundant and makes every stationary
    // block pay exponential-motion cost on every scene retarget.
    if (target === this.targetValue) return;
    const current = this.sample(timeMs);
    this.startValue = current.value;
    const displacement = target - current.value;
    const candidateVelocity = incomingVelocity ?? current.velocity;
    const maximumMonotonicVelocity = Math.max(0.001, this.config.omega) *
      Math.abs(displacement);
    this.startVelocity = candidateVelocity * displacement <= 0
      ? 0
      : Math.sign(displacement) * Math.min(
        Math.abs(candidateVelocity),
        maximumMonotonicVelocity,
      );
    this.targetValue = target;
    this.startTimeMs = timeMs;
    this.isSettled = false;
  }

  snap(target: number, timeMs: number): void {
    this.startValue = target;
    this.startVelocity = 0;
    this.targetValue = target;
    this.startTimeMs = timeMs;
    this.isSettled = true;
  }
}

export class DampedRectMotion {
  private readonly left: DampedScalarMotion;
  private readonly top: DampedScalarMotion;
  private readonly width: DampedScalarMotion;
  private readonly height: DampedScalarMotion;

  constructor(rect: SceneRect, startTimeMs: number, config: SceneMotionConfig) {
    if (!isFiniteSceneRect(rect)) throw new Error("Initial scene rectangle must be finite");
    this.left = new DampedScalarMotion(rect.left, startTimeMs, config);
    this.top = new DampedScalarMotion(rect.top, startTimeMs, config);
    this.width = new DampedScalarMotion(rect.width, startTimeMs, config);
    this.height = new DampedScalarMotion(rect.height, startTimeMs, config);
  }

  target(): SceneRect {
    return {
      left: this.left.target(),
      top: this.top.target(),
      width: this.width.target(),
      height: this.height.target(),
    };
  }

  sample(timeMs: number): SceneMotionSample {
    const left = this.left.sample(timeMs);
    const top = this.top.sample(timeMs);
    const width = this.width.sample(timeMs);
    const height = this.height.sample(timeMs);
    const rect = {
      left: left.value,
      top: top.value,
      width: Math.max(0, width.value),
      height: Math.max(0, height.value),
    };
    const velocity: SceneVelocity = {
      left: left.velocity,
      top: top.velocity,
      width: width.velocity,
      height: height.velocity,
    };
    return {
      rect,
      velocity,
      settled: left.settled && top.settled && width.settled && height.settled,
    };
  }

  retarget(rect: SceneRect, timeMs: number): void {
    if (!isFiniteSceneRect(rect)) throw new Error("Scene rectangle target must be finite");
    this.left.retarget(rect.left, timeMs);
    this.top.retarget(rect.top, timeMs);
    this.width.retarget(rect.width, timeMs);
    this.height.retarget(rect.height, timeMs);
  }

  snap(rect: SceneRect, timeMs: number): void {
    const target = copyRect(rect);
    this.left.snap(target.left, timeMs);
    this.top.snap(target.top, timeMs);
    this.width.snap(target.width, timeMs);
    this.height.snap(target.height, timeMs);
  }
}

/**
 * One coherent analytic phase for every visual rectangle in the drag scene.
 *
 * Each retarget captures every currently presented rectangle, then moves all
 * of their edges through one normalized progress curve. Any edge and any gap
 * between two edges is therefore one affine function of the same progress: a
 * preset may include its intentional legacy easing overshoot, but blocks,
 * nested containers, and filler cannot settle out of phase with each other.
 */
export class DragSceneMotionSystem<Key> {
  private startRects = new Map<Key, SceneRect>();
  private targetRects = new Map<Key, SceneRect>();
  private progress: ProgressMotion | null = null;

  constructor(private readonly config: SceneMotionConfig) {}

  seed(rects: ReadonlyMap<Key, SceneRect>, timeMs: number): void {
    this.startRects = new Map(Array.from(rects, ([key, rect]) => [key, copyRect(rect)]));
    this.targetRects = new Map(Array.from(rects, ([key, rect]) => [key, copyRect(rect)]));
    this.progress = this.settledProgress(timeMs);
  }

  retarget(
    rects: ReadonlyMap<Key, SceneRect>,
    timeMs: number,
    options: SceneMotionRetargetOptions<Key> = {},
  ): void {
    if (this.targetsEqual(rects) && !options.restartOnEqualTarget) return;
    const priorProgress = this.progress?.sample(timeMs) ?? {
      value: 1,
      velocity: 0,
      settled: true,
    };
    const current = this.sampleAtProgress(priorProgress);
    const starts = new Map<Key, SceneRect>();
    const targets = new Map<Key, SceneRect>();
    let maximumDistance = 0;
    for (const [key, target] of rects) {
      const start = options.snapKeys?.has(key)
        ? target
        : current.get(key)?.rect ?? target;
      starts.set(key, copyRect(start));
      targets.set(key, copyRect(target));
      maximumDistance = Math.max(
        maximumDistance,
        Math.abs(target.left - start.left),
        Math.abs(target.top - start.top),
        Math.abs(target.width - start.width),
        Math.abs(target.height - start.height),
      );
    }
    this.startRects = starts;
    this.targetRects = targets;
    if (maximumDistance <= Number.EPSILON) {
      this.progress = this.settledProgress(timeMs);
      return;
    }
    const durationMs = options.sceneDurationMs ?? this.config.sceneDurationMs;
    const easing = options.sceneEasing ?? this.config.sceneEasing;
    if (durationMs != null && easing != null) {
      this.progress = new CubicBezierProgressMotion(
        timeMs,
        durationMs,
        easing,
      );
    } else {
      const progress = new DampedScalarMotion(
        0,
        timeMs,
        this.progressConfig(maximumDistance),
      );
      progress.retarget(1, timeMs, priorProgress.velocity);
      this.progress = progress;
    }
  }

  sample(timeMs: number): Map<Key, SceneMotionSample> {
    const progress = this.progress?.sample(timeMs) ?? {
      value: 1,
      velocity: 0,
      settled: true,
    };
    return this.sampleAtProgress(progress);
  }

  snapToTargets(timeMs: number): void {
    this.startRects = new Map(Array.from(
      this.targetRects,
      ([key, rect]) => [key, copyRect(rect)],
    ));
    this.progress = this.settledProgress(timeMs);
  }

  private settledProgress(timeMs: number): ProgressMotion {
    return new DampedScalarMotion(1, timeMs, this.progressConfig(1));
  }

  private progressConfig(maximumDistance: number): SceneMotionConfig {
    const distance = Math.max(Number.EPSILON, maximumDistance);
    return {
      omega: this.config.omega,
      positionTolerance: Math.min(1, this.config.positionTolerance / distance),
      velocityTolerance: this.config.velocityTolerance / distance,
    };
  }

  private targetsEqual(rects: ReadonlyMap<Key, SceneRect>): boolean {
    if (rects.size !== this.targetRects.size) return false;
    for (const [key, rect] of rects) {
      const target = this.targetRects.get(key);
      if (!target || target.left !== rect.left || target.top !== rect.top ||
          target.width !== rect.width || target.height !== rect.height) return false;
    }
    return true;
  }

  private sampleAtProgress(progress: ScalarSample): Map<Key, SceneMotionSample> {
    const result = new Map<Key, SceneMotionSample>();
    const amount = Math.max(0, progress.value);
    for (const [key, target] of this.targetRects) {
      const start = this.startRects.get(key) ?? target;
      const leftDistance = target.left - start.left;
      const topDistance = target.top - start.top;
      const widthDistance = target.width - start.width;
      const heightDistance = target.height - start.height;
      result.set(key, {
        rect: {
          left: start.left + leftDistance * amount,
          top: start.top + topDistance * amount,
          width: Math.max(0, start.width + widthDistance * amount),
          height: Math.max(0, start.height + heightDistance * amount),
        },
        velocity: {
          left: leftDistance * progress.velocity,
          top: topDistance * progress.velocity,
          width: widthDistance * progress.velocity,
          height: heightDistance * progress.velocity,
        },
        settled: progress.settled,
      });
    }
    return result;
  }
}
