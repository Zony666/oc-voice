import { createMicrophoneCapture } from "../shared/audio.js";
import {
  DictationController,
  type DictationState,
} from "../shared/dictation-controller.js";
import type { TranscribeSettings } from "../shared/settings.js";
import { TranscriptionService } from "../shared/transcription-service.js";

export type VoicePhase = DictationState["phase"];
export type VoiceResult = {
  text: string;
  speechSeconds: number;
  transcribeSeconds: number;
};

export type VoiceEngineHandlers = {
  onState?: (state: DictationState) => void;
  onFrame?: (frame: Int16Array) => void;
};

const ACTIVE_PHASES: readonly VoicePhase[] = [
  "starting",
  "listening",
  "transcribing",
  "cancelling",
];

/**
 * Owns the microphone and the loaded model. Mirrors pi-voice's runtime: one
 * reusable DictationController and one TranscriptionService for the process,
 * never a TUI or OpenCode dependency. Everything here runs locally.
 */
export class VoiceEngine {
  private readonly service = new TranscriptionService();
  private controller: DictationController | undefined;
  private disposed = false;

  constructor(private readonly handlers: VoiceEngineHandlers = {}) {}

  private ensure(): DictationController {
    if (!this.controller) {
      this.controller = new DictationController(this.service, {
        createCapture: createMicrophoneCapture,
        onFrame: (frame) => this.handlers.onFrame?.(frame),
        onChange: (state) => this.handlers.onState?.(state),
      });
    }
    return this.controller;
  }

  get phase(): VoicePhase {
    return this.controller?.state.phase ?? "idle";
  }

  get modelState(): "loading" | "ready" | "failed" {
    return this.controller?.modelState ?? "loading";
  }

  get elapsedMs(): number {
    return this.controller?.elapsedMs ?? 0;
  }

  get busy(): boolean {
    return ACTIVE_PHASES.includes(this.phase);
  }

  isModelLoaded(modelPath: string): boolean {
    return this.service.isModelLoaded(modelPath);
  }

  setKeepModelLoaded(enabled: boolean): void {
    this.service.setKeepModelLoaded(enabled);
  }

  /** Warm the model in the background; safe to call repeatedly. */
  prepare(settings: TranscribeSettings): void {
    if (this.disposed) return;
    this.ensure().prepare(settings);
  }

  async start(
    settings: TranscribeSettings,
    options: { waitForModel?: boolean; shouldStart?: () => boolean } = {},
  ): Promise<void> {
    if (this.disposed) return;
    await this.ensure().start(settings, options);
  }

  async stop(): Promise<VoiceResult | undefined> {
    if (this.disposed) return undefined;
    return this.controller?.stop();
  }

  async cancel(): Promise<void> {
    if (this.disposed) return;
    await this.controller?.cancel();
  }

  async shutdown(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const controller = this.controller;
    this.controller = undefined;
    await controller?.dispose();
    await this.service.shutdown();
  }
}
