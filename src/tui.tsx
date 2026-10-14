import { Plugin } from "@opencode/plugin/tui";
import type { KeyEvent, RGBA } from "@opentui/core";
import { Show, createSignal } from "solid-js";
import { readSettings, writeSettings } from "./config.js";
import { HoldCapture, SpaceHoldGesture } from "./engine/space-hold.js";
import { VoiceEngine } from "./engine/voice.js";
import { getAvailableMicrophones } from "./shared/audio.js";
import {
  CATALOG_MODELS,
  displayLanguage,
  formatBinarySize,
  getCatalogModel,
  type CatalogModel,
} from "./shared/catalog.js";
import { chineseOutputSummary, isChineseLanguage } from "./shared/chinese.js";
import { downloadCatalogModel, findCachedCatalogModel } from "./shared/models.js";
import {
  settingsForModel,
  type InputMode,
  type MicrophoneSetting,
  type TranscribeSettings,
} from "./shared/settings.js";
import { displayShortcut } from "./shared/shortcut-core.js";

/** Braille spinner, the same style OpenCode uses for its working indicator. */
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(totalSeconds / 60)}:${(totalSeconds % 60).toString().padStart(2, "0")}`;
}

function microphoneSummary(microphone: MicrophoneSetting): string {
  if (microphone.type === "system-default") return "System default";
  return microphone.occurrence > 0
    ? `${microphone.name} · device ${microphone.occurrence + 1}`
    : microphone.name;
}

function transcriptionLanguageLabel(language: string, model: CatalogModel): string {
  if (language === "auto") return "Auto detect";
  return displayLanguage(language);
}

function defaultSpokenLanguages(): string[] {
  const locale = Intl.DateTimeFormat().resolvedOptions().locale;
  const base = locale.toLowerCase().split("-")[0];
  return base ? [base] : ["en"];
}

export default Plugin.define({
  id: "op-voice",
  async setup(context) {
    const initial = await readSettings();

    const [phase, setPhase] = createSignal<string>("idle");
    const [modelState, setModelState] = createSignal<"loading" | "ready" | "failed">("loading");
    const [elapsed, setElapsed] = createSignal(0);
    const [shortcut, setShortcut] = createSignal("ctrl+alt+z");
    const [inputMode, setInputMode] = createSignal<InputMode>("toggle");
    const [frame, setFrame] = createSignal(0);

    let settings: TranscribeSettings | undefined;
    let disposed = false;
    let previousPhase = "";

    const engine = new VoiceEngine({
      onState: (state) => {
        setPhase(state.phase);
        if (state.phase === "listening" && previousPhase !== "listening") {
          notify("🎤 Recording…");
        }
        previousPhase = state.phase;
        if (state.phase === "error") {
          const message = state.cause instanceof Error ? state.cause.message : String(state.cause);
          context.ui.toast.show({ message: `Voice ${state.stage} failed: ${message}`, variant: "error" });
        }
      },
    });

    const ticker = setInterval(() => {
      if (engine.busy) {
        setElapsed(engine.elapsedMs);
        setModelState(engine.modelState);
        setFrame((value) => (value + 1) % SPINNER_FRAMES.length);
      }
    }, 200);

    function notify(message: string, variant: "info" | "success" | "warning" | "error" = "info"): void {
      context.ui.toast.show({ message, variant });
    }

    /** Insert the transcript for review; fall back to a prefilled dialog. */
    async function deliver(text: string): Promise<void> {
      if (!text) {
        notify("No speech detected", "warning");
        return;
      }
      const editor = context.renderer.currentFocusedEditor;
      if (editor) {
        try {
          editor.insertText(text);
          return;
        } catch {
          // Fall through to the dialog below.
        }
      }
      const route = context.ui.router.current();
      const sessionID = route.type === "session" ? route.sessionID : undefined;
      const edited = await context.ui.dialog.prompt({
        title: "Voice transcript",
        description: "Edit, then Enter to send it to the session",
        value: text,
      });
      if (edited && sessionID) {
        await context.client.session.prompt({ sessionID, text: edited });
      }
    }

    async function stopAndDeliver(): Promise<void> {
      const result = await engine.stop();
      if (!result) return;
      await deliver(result.text);
      if (result.text) {
        notify(
          `Transcribed ${result.speechSeconds.toFixed(1)}s of audio in ${result.transcribeSeconds.toFixed(1)}s`,
          "success",
        );
      }
    }

    async function cancel(): Promise<void> {
      await engine.cancel();
      notify("Recording discarded");
    }

    async function toggle(): Promise<void> {
      const current = engine.phase;
      if (current === "listening") {
        await stopAndDeliver();
        return;
      }
      if (current === "starting") {
        await cancel();
        return;
      }
      if (engine.busy) return; // transcribing or cancelling: let it finish
      const configured = await ensureConfigured();
      if (!configured) return;
      await engine.start(configured);
    }

    const holdCapture = new HoldCapture({
      start: async (stillHeld) => {
        const configured = settings;
        if (!configured) return false;
        await engine.start(configured, { waitForModel: true, shouldStart: stillHeld });
        return engine.phase === "listening";
      },
      stop: async () => stopAndDeliver(),
      cancel: async () => engine.cancel(),
      error: (error) =>
        notify(`Hold Space failed: ${error instanceof Error ? error.message : String(error)}`, "error"),
    });

    const gesture = new SpaceHoldGesture({
      enabled: () => !disposed && inputMode() === "hold-space" && !engine.busy && Boolean(settings),
      deleteTyped: (count) => {
        const editor = context.renderer.currentFocusedEditor;
        if (editor && editor.plainText.endsWith(" ".repeat(count))) {
          for (let index = 0; index < count; index += 1) editor.deleteCharBackward();
        }
        // Never block the hold: the composer may be unreachable, and leaving a
        // few spaces behind is preferable to silently doing nothing.
        return true;
      },
      start: () => {
        holdCapture.begin();
      },
      end: () => {
        holdCapture.end();
      },
      now: () => performance.now(),
    });

    // Commands available everywhere (toggle, discard, settings). A named
    // command's binding is only active when its id is listed in `bindings`.
    context.keymap.layer(() => ({
      mode: "global",
      priority: 10,
      bindings: ["op-voice.toggle", "op-voice.cancel"],
      commands: [
        {
          id: "op-voice.toggle",
          title: "Toggle voice dictation",
          group: "Voice",
          bind: shortcut(),
          palette: true,
          enabled: () => !disposed,
          run: () => toggle(),
        },
        {
          id: "op-voice.cancel",
          title: "Discard voice recording",
          group: "Voice",
          bind: "escape",
          enabled: () => {
            const current = phase();
            return current === "starting" || current === "listening" || current === "transcribing";
          },
          run: () => cancel(),
        },
        {
          id: "op-voice.settings",
          title: "Voice settings",
          group: "Voice",
          slash: { name: "voice" },
          palette: true,
          run: () => openSettings(),
        },
      ],
    }));

    // Hold Space. The layer stays global so the binding is always reachable;
    // it only engages while a prompt editor is focused. Returning false lets
    // the space through; a detected hold consumes the key.
    context.keymap.layer(() => ({
      mode: "global",
      priority: 20,
      bindings: ["op-voice.hold"],
      commands: [
        {
          id: "op-voice.hold",
          title: "Hold Space to dictate",
          group: "Voice",
          bind: "space",
          enabled: () => inputMode() === "hold-space",
          run: (_input, event) => {
            if (!context.renderer.currentFocusedEditor) return false;
            const key = event as KeyEvent | undefined;
            if (key?.eventType === "release") {
              gesture.release();
              return false;
            }
            const step = gesture.process(true);
            return step === "swallow" ? undefined : false;
          },
        },
      ],
    }));

    const renderMeter = () => (
      <Show when={meterLine()}>
        <box flexDirection="row" gap={1} flexShrink={0}>
          <text fg={meterColor()}>{meterLine()}</text>
        </box>
      </Show>
    );
    // Same slot OpenCode uses for its working indicator ("esc to interrupt"), so
    // the recording meter sits in the footer status area on every prompt view.
    context.ui.slot({ append: "prompt.footer.status", render: renderMeter });

    function meterLine(): string {
      const current = phase();
      if (current !== "starting" && current !== "listening" && current !== "transcribing") return "";
      const spin = SPINNER_FRAMES[frame()] ?? "⠋";
      if (current === "starting") return `${spin} starting…`;
      if (current === "transcribing") return `${spin} transcribing…`;
      const state = modelState() === "loading" ? " · loading" : modelState() === "failed" ? " · failed" : "";
      return `${spin} voice ${formatElapsed(elapsed())}${state}`;
    }

    /** Match the host footer: muted for idle states, primary text while recording. */
    function meterColor(): RGBA | string | undefined {
      const theme = context.theme as {
        text?: { base?: RGBA; muted?: RGBA };
      };
      return phase() === "listening" ? theme.text?.base : theme.text?.muted;
    }

    // --- configuration -------------------------------------------------------

    function refreshFromSettings(configured: TranscribeSettings): void {
      settings = configured;
      setShortcut(configured.shortcut);
      setInputMode(configured.inputMode);
      engine.setKeepModelLoaded(configured.keepModelLoaded);
    }

    function applySettings(result: Awaited<ReturnType<typeof readSettings>>): TranscribeSettings | undefined {
      if (result.warning) notify(result.warning, "warning");
      if (result.settings) refreshFromSettings(result.settings);
      return result.settings;
    }

    async function ensureConfigured(): Promise<TranscribeSettings | undefined> {
      if (settings) return settings;
      const configured = await runSetup();
      return configured;
    }

    async function chooseModel(currentId: string | undefined): Promise<{ id: string; path: string } | undefined> {
      const options = CATALOG_MODELS.map((model) => {
        const cached = findCachedCatalogModel(model);
        return {
          title: model.name,
          value: model.id,
          description: `${cached ? "on disk" : formatBinarySize(model.size)} · ${model.languages.slice(0, 4).join(", ")}`,
        };
      });
      const id = await context.ui.dialog.select<string>({
        title: "Choose a speech model",
        placeholder: "Search models",
        options,
        current: currentId,
        search: (query, items) =>
          items.filter((item) =>
            `${item.title} ${item.value} ${item.description ?? ""}`.toLowerCase().includes(query.toLowerCase()),
          ),
      });
      if (!id) return undefined;
      const model = getCatalogModel(id);
      if (!model) return undefined;
      const cached = findCachedCatalogModel(model);
      if (cached) return { id, path: cached.path };
      notify(`Downloading ${model.name} (${formatBinarySize(model.size)})…`);
      try {
        const path = await downloadCatalogModel(model, {
          onProgress: ({ downloaded, total }) => {
            if (total > 0 && downloaded === total) notify(`Downloaded ${model.name}`, "success");
          },
        });
        return { id, path };
      } catch (error) {
        notify(`Download failed: ${error instanceof Error ? error.message : String(error)}`, "error");
        return undefined;
      }
    }

    async function chooseMicrophone(current: MicrophoneSetting): Promise<MicrophoneSetting | undefined> {
      let devices: string[] = [];
      try {
        devices = getAvailableMicrophones();
      } catch (error) {
        notify(`Could not list microphones: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
      const totals = new Map<string, number>();
      for (const name of devices) totals.set(name, (totals.get(name) ?? 0) + 1);
      const seen = new Map<string, number>();
      const byValue = new Map<string, MicrophoneSetting>();
      byValue.set("system-default", { type: "system-default" });
      let currentValue = "system-default";
      const options = [
        { title: "System default", value: "system-default", description: "Follow the OS input device" },
        ...devices.map((name, index) => {
          const occurrence = seen.get(name) ?? 0;
          seen.set(name, occurrence + 1);
          const microphone: MicrophoneSetting = { type: "device", name, occurrence };
          const value = `device-${index}`;
          byValue.set(value, microphone);
          if (
            current.type === "device" &&
            current.name === name &&
            current.occurrence === occurrence
          ) {
            currentValue = value;
          }
          return {
            title: (totals.get(name) ?? 0) > 1 ? `${name} · device ${occurrence + 1}` : name,
            value,
          };
        }),
      ];
      const choice = await context.ui.dialog.select<string>({
        title: "Choose microphone",
        options,
        current: currentValue,
      });
      return choice ? byValue.get(choice) : undefined;
    }

    async function runSetup(existing?: TranscribeSettings): Promise<TranscribeSettings | undefined> {
      const model = await chooseModel(existing?.model.id);
      if (!model) return undefined;
      const configured = settingsForModel(model.id, model.path, {
        shortcut: existing?.shortcut,
        inputMode: existing?.inputMode,
        keepModelLoaded: existing?.keepModelLoaded,
        preferredLanguages: existing?.preferredLanguages ?? defaultSpokenLanguages(),
        transcriptionLanguage: existing?.transcriptionLanguage,
        chineseOutput: existing?.chineseOutput,
        microphone: existing?.microphone,
        ffmpegPath: existing?.ffmpegPath,
      });
      try {
        await writeSettings(configured);
      } catch (error) {
        notify(`Could not save settings: ${error instanceof Error ? error.message : String(error)}`, "error");
        return undefined;
      }
      refreshFromSettings(configured);
      notify(`Voice ready · press ${displayShortcut(configured.shortcut)} or hold Space`, "success");
      return configured;
    }

    async function openSettings(): Promise<void> {
      const configured = settings ?? (await runSetup());
      if (!configured) return;
      const base: TranscribeSettings = configured;
      while (true) {
        const model = getCatalogModel(configured.model.id);
        const choice = await context.ui.dialog.select<string>({
          title: "Voice settings",
          options: [
            { title: "Model", value: "model", description: model?.name ?? configured.model.id },
            {
              title: "Transcription language",
              value: "language",
              description: model
                ? transcriptionLanguageLabel(configured.transcriptionLanguage, model)
                : configured.transcriptionLanguage,
            },
            {
              title: "Voice input mode",
              value: "input-mode",
              description: configured.inputMode === "hold-space" ? "Hold Space" : "Toggle shortcut",
            },
            {
              title: "Microphone",
              value: "microphone",
              description: microphoneSummary(configured.microphone),
            },
            {
              title: "Keep model loaded",
              value: "retention",
              description: configured.keepModelLoaded ? "On" : "Off",
            },
            ...(isChineseLanguage(configured.transcriptionLanguage) ||
            configured.preferredLanguages.some(isChineseLanguage)
              ? [
                  {
                    title: "Chinese output",
                    value: "chinese",
                    description: chineseOutputSummary(configured.chineseOutput),
                  },
                ]
              : []),
            {
              title: "ffmpeg path",
              value: "ffmpeg",
              description: configured.ffmpegPath ?? "ffmpeg on PATH",
            },
            { title: "Shortcut", value: "shortcut", description: `${displayShortcut(configured.shortcut)} (edit in cli.json)` },
          ],
        });
        if (!choice) return;

        if (choice === "model") {
          const selected = await chooseModel(configured.model.id);
          if (selected) {
            // Reset the transcription language to the new model's default
            // (auto-detect when supported) instead of carrying over the old
            // model's explicit language, which silently translated speech.
            const updated = settingsForModel(selected.id, selected.path, {
              ...configured,
              transcriptionLanguage: undefined,
            });
            await persist(updated);
          }
        } else if (choice === "language") {
          if (!model) continue;
          const languageOptions = [
            ...(model.capabilities.languageDetection
              ? [{ title: "Auto detect", value: "auto", description: "Detect the spoken language automatically" }]
              : []),
            ...[...new Set(model.languages)].map((code) => ({
              title: displayLanguage(code),
              value: code,
            })),
          ];
          const language = await context.ui.dialog.select<string>({
            title: "Transcription language",
            options: languageOptions,
            current: configured.transcriptionLanguage,
          });
          if (language && language !== configured.transcriptionLanguage) {
            const preferredLanguages =
              language === "auto"
                ? configured.preferredLanguages
                : [...new Set([language, ...configured.preferredLanguages])];
            await persist({ ...configured, transcriptionLanguage: language, preferredLanguages });
          }
        } else if (choice === "input-mode") {
          const mode = await context.ui.dialog.select<InputMode>({
            title: "Voice input mode",
            options: [
              { title: "Toggle shortcut", value: "toggle", description: "Press the shortcut to start and stop" },
              { title: "Hold Space", value: "hold-space", description: "Hold Space in the prompt to dictate" },
            ],
            current: configured.inputMode,
          });
          if (mode && mode !== configured.inputMode) await persist({ ...configured, inputMode: mode });
        } else if (choice === "microphone") {
          const microphone = await chooseMicrophone(configured.microphone);
          if (microphone) await persist({ ...configured, microphone });
        } else if (choice === "retention") {
          await persist({ ...configured, keepModelLoaded: !configured.keepModelLoaded });
        } else if (choice === "chinese") {
          const output = await context.ui.dialog.select<TranscribeSettings["chineseOutput"]>({
            title: "Chinese output",
            options: [
              { title: "Simplified", value: "simplified" },
              { title: "Traditional (Taiwan)", value: "traditional-taiwan" },
              { title: "Traditional (Hong Kong)", value: "traditional-hong-kong" },
            ],
            current: configured.chineseOutput,
          });
          if (output) await persist({ ...configured, chineseOutput: output });
        } else if (choice === "ffmpeg") {
          const value = await context.ui.dialog.prompt({
            title: "ffmpeg path",
            description:
              "Executable used by transcribe_file. Leave empty to use OP_VOICE_FFMPEG_PATH or ffmpeg on PATH.",
            placeholder: "ffmpeg",
            value: configured.ffmpegPath ?? "",
          });
          if (value !== undefined) {
            const next = { ...configured };
            const ffmpegPath = value.trim();
            if (ffmpegPath) next.ffmpegPath = ffmpegPath;
            else delete next.ffmpegPath;
            await persist(next);
          }
        } else if (choice === "shortcut") {
          notify(`Change the binding for "op-voice.toggle" in cli.json keybinds; current: ${displayShortcut(configured.shortcut)}`);
        }

        async function persist(updated: TranscribeSettings): Promise<void> {
          try {
            await writeSettings(updated);
            Object.assign(base, updated);
            refreshFromSettings(base);
            notify("Voice settings saved", "success");
          } catch (error) {
            notify(`Could not save settings: ${error instanceof Error ? error.message : String(error)}`, "error");
          }
        }
      }
    }

    applySettings(initial);

    return async () => {
      disposed = true;
      clearInterval(ticker);
      gesture.dispose();
      holdCapture.dispose();
      await engine.shutdown();
    };
  },
});
