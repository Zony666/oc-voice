// Repeat-cadence detection, inspired by OMP's space-hold gesture. This is an
// approximation of key-up, not a claim that the terminal reports releases.
export const SPACE_RELEASE_MS = 250;
export const SPACE_MAX_RECORDING_MS = 120_000;
/**
 * A gap this short between two spaces is plausible OS auto-repeat rather than
 * deliberate typing. Auto-repeat is also highly regular, which is what the
 * cadence check relies on; this ceiling only keeps slower, deliberate spaces
 * out. Key-repeat settings slower than roughly five repeats per second still
 * fall outside this window and should use the toggle shortcut instead.
 */
export const SPACE_REPEAT_MAX_GAP_MS = 200;
export type SpaceStep = "pass" | "type" | "swallow";

export class SpaceHoldGesture {
  private typed = 0;
  private run = 0;
  private previousGap: number | undefined;
  private last = -Infinity;
  private active = false;
  private blocked = false;
  private releaseTimer: ReturnType<typeof setTimeout> | undefined;
  private limitTimer: ReturnType<typeof setTimeout> | undefined;
  private releaseCheck: ReturnType<typeof setImmediate> | undefined;
  private releaseGeneration = 0;

  constructor(private readonly host: {
    enabled(): boolean;
    deleteTyped(count: number): boolean;
    start(): void;
    end(): void;
    now?: () => number;
  }) {}

  process(space: boolean): SpaceStep {
    if (this.active || this.blocked) {
      if (space) { this.armRelease(); return "swallow"; }
      this.end();
      return "pass";
    }
    if (!space || !this.host.enabled()) { this.reset(); return "pass"; }
    const now = this.host.now?.() ?? performance.now();
    const gap = now - this.last;
    const previous = this.previousGap;
    this.last = now;
    this.previousGap = gap;
    // Keep the initial key-down across the OS repeat delay, but do not roll
    // back a long history of deliberate slow spaces when a new hold starts.
    if (gap > SPACE_REPEAT_MAX_GAP_MS && !(this.typed === 1 && previous === Infinity && gap <= 1_000)) this.typed = 0;
    const mechanical = previous !== undefined && gap >= 0 && gap <= SPACE_REPEAT_MAX_GAP_MS && previous <= SPACE_REPEAT_MAX_GAP_MS &&
      Math.abs(gap - previous) <= Math.max(18, Math.min(gap, previous) * 0.35);
    if (!mechanical) { this.run = 0; this.typed++; return "type"; }
    if (++this.run < 2) { this.typed++; return "type"; }
    const deleted = this.host.deleteTyped(this.typed);
    this.reset();
    if (!deleted) return "type";
    this.active = true;
    this.armRelease();
    this.limitTimer = setTimeout(() => {
      // Until the user lets go, swallow repeats rather than restarting.
      this.limitTimer = undefined;
      this.active = false;
      this.blocked = true;
      this.host.end();
    }, SPACE_MAX_RECORDING_MS);
    this.limitTimer.unref?.();
    this.host.start();
    return "swallow";
  }

  release(): void { this.end(); }
  dispose(): void { this.end(); }

  private reset(): void {
    this.typed = this.run = 0;
    this.previousGap = undefined;
    this.last = -Infinity;
  }
  private armRelease(): void {
    if (this.releaseTimer) clearTimeout(this.releaseTimer);
    if (this.releaseCheck) clearImmediate(this.releaseCheck);
    const generation = ++this.releaseGeneration;
    this.releaseTimer = setTimeout(() => {
      this.releaseTimer = undefined;
      // A cold native load can block timers and stdin together. Give pending
      // terminal input a poll turn before deciding that repeats really ended.
      this.releaseCheck = setImmediate(() => {
        this.releaseCheck = undefined;
        if (generation !== this.releaseGeneration) return;
        if (this.active) {
          // Drain the tail of this same hold even if the capture already ended.
          // Otherwise buffered repeats become editor spaces while transcribing.
          this.active = false;
          this.blocked = true;
          if (this.limitTimer) clearTimeout(this.limitTimer);
          this.limitTimer = undefined;
          this.reset();
          this.armRelease();
          this.host.end();
        } else this.end();
      });
      this.releaseCheck.unref?.();
    }, SPACE_RELEASE_MS);
    this.releaseTimer.unref?.();
  }
  private end(): void {
    const wasActive = this.active;
    this.active = this.blocked = false;
    if (this.releaseTimer) clearTimeout(this.releaseTimer);
    if (this.limitTimer) clearTimeout(this.limitTimer);
    if (this.releaseCheck) clearImmediate(this.releaseCheck);
    ++this.releaseGeneration;
    this.releaseCheck = undefined;
    this.releaseTimer = this.limitTimer = undefined;
    this.reset();
    if (wasActive) this.host.end();
  }
}

/** Separate the synchronous key gesture from asynchronous microphone startup.
 * A release during startup is retained; failed starts never call stop. */
type HeldTake = { released: boolean; discarded: boolean; starting: Promise<boolean>; stopping?: Promise<void> };

export class HoldCapture {
  private take: HeldTake | undefined;
  private disposed = false;
  constructor(private readonly callbacks: {
    start(stillHeld: () => boolean): Promise<boolean>;
    stop(): Promise<void>;
    cancel?(): Promise<void>;
    error(error: unknown): void;
  }) {}
  get busy(): boolean { return this.take !== undefined; }
  begin(): void {
    if (this.disposed || this.take) return;
    const take: HeldTake = { released: false, discarded: false, starting: Promise.resolve(false) };
    this.take = take;
    take.starting = Promise.resolve().then(() => this.disposed ? false : this.callbacks.start(() => !this.disposed && !take.released))
      .catch((error: unknown) => { this.callbacks.error(error); return false; });
    void take.starting.then((started) => {
      if (!started) { if (this.take === take) this.take = undefined; }
      else if (take.released) this.finish(take);
    });
  }
  end(): void {
    const take = this.take;
    if (!take) return;
    take.released = true;
    this.finish(take);
  }
  cancel(): void {
    if (this.take) this.take.discarded = true;
    this.end();
  }
  private finish(take: HeldTake): void {
    if (take.stopping) return;
    take.stopping = take.starting.then(async (started) => {
      if (started && !this.disposed) {
        if (take.discarded && this.callbacks.cancel) await this.callbacks.cancel();
        else await this.callbacks.stop();
      }
    }).catch((error: unknown) => this.callbacks.error(error)).finally(() => {
      if (this.take === take) this.take = undefined;
    });
  }
  dispose(): void { this.disposed = true; }
}
