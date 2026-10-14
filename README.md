# op-voice — local speech-to-text for OpenCode

Local dictation for [OpenCode](https://opencode.ai) V2. Hold **Space** (or press a
shortcut), speak, and the transcript is **inserted into the prompt for review** —
it is never auto-sent. Audio capture and transcription run locally; nothing
leaves your machine.

This is a port of [pi-voice](https://github.com/earendil-works/pi-voice) to
OpenCode's plugin API. The engine (pvrecorder capture, transcribe.cpp, the
dictation controller, model catalog/download, Chinese conversion) is reused from
pi-voice almost verbatim; only the integration layer is OpenCode-native. It uses
only documented OpenCode plugin APIs and does **not** read or modify OpenCode's
own configuration, database, or source.

## Requirements

- OpenCode V2 (tested against `@opencode/plugin` 2.0.28 / `@opentui/core` 0.5.17)
- Node 22+ (native engine + `transcribe_file` decoding)
- `ffmpeg` on `PATH` (or `OP_VOICE_FFMPEG_PATH`) for the `transcribe_file` tool
- A terminal that reports key repeat/release (Kitty keyboard protocol) for
  precise Hold Space; otherwise the repeat-cadence heuristic is used.

## Install

Clone the repository and point OpenCode at the checkout directory.

The **CLI/TUI plugin** owns the microphone and the UI and runs locally, so it
also works against a remote server. Add the checkout to `cli.json`:

```json
{
  "plugins": ["/path/to/op-voice"]
}
```

Or try it without editing your global config:

```sh
OPENCODE_CLI_CONFIG_CONTENT='{"plugins":["/path/to/op-voice"]}' opencode
```

The **server plugin** (`transcribe_file` tool) is loaded from `opencode.json(c)`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["/path/to/op-voice"]
}
```

Both entrypoints ship from one package (`exports: { ".": "./src/index.ts",
"./tui": "./src/tui.tsx" }`).

For development, this repository already contains `.opencode/plugins/op-voice/`,
which re-exports both entrypoints; running OpenCode from the checkout loads the
plugin automatically.

## Usage

- **Toggle**: press the shortcut (default `Ctrl+Alt+Z`). Change the binding for
  `op-voice.toggle` in `cli.json` keybinds.
- **Hold Space**: enable it in `/voice` → **Voice input mode** → **Hold Space**,
  then hold Space in the prompt. Releasing transcribes.
- **`/voice`**: settings — model (with download), transcription language,
  input mode, microphone, model retention, Chinese output.
- **Escape**: discard the current recording while it is active.

The transcript is inserted at the prompt cursor for review. If the composer
cannot be reached, op-voice falls back to a prefilled dialog and sends on Enter.

## Architecture (mirrors pi-voice)

```
src/
  tui.tsx        OpenCode CLI plugin: keymap (toggle + Hold Space), meter slot,
                 dialogs, insert-for-review, local VoiceEngine
  index.ts       OpenCode server plugin: transcribe_file tool
  engine/
    voice.ts     VoiceEngine: owns one DictationController + TranscriptionService
    space-hold.ts  ported repeat-cadence gesture (press/repeat/release aware)
  shared/        ported pi-voice engine (no OpenCode/pi dependencies)
    audio.ts transcription.ts transcription-service.ts dictation-controller.ts
    models.ts catalog.ts chinese.ts languages.ts log.ts pcm*.ts file-audio.ts
```

Configuration is owned by op-voice, not OpenCode:

- Windows: `%APPDATA%\op-voice\settings.json`
- Other: `~/.config/op-voice/settings.json` (or `$XDG_CONFIG_HOME/op-voice`)
- Override with `OP_VOICE_CONFIG_DIR`
- Models use the standard Hugging Face cache (`HF_HUB_CACHE`/`HF_HOME` respected)

## Status

Verified:

- Type-checks against `@opencode/plugin` 2.0.28 and `@opentui/core` 0.5.17.
- Loads and runs inside a real OpenCode V2 CLI: the plugin is discovered from
  `.opencode/plugins/op-voice`, the server entry registers its tool, and the TUI
  `setup()` completes without errors.
- Native stack imports under OpenCode's runtime: `@picovoice/pvrecorder-node`
  enumerates devices and `transcribe-cpp` reports its GPU/CPU backends.

Still needs a real interactive OpenCode session to confirm:

- keymap dispatch: that a `space` binding returning `false` lets the space
  through, and consuming stops it;
- Hold Space timing and the candidate-space deletion in the composer;
- composer insertion via `renderer.currentFocusedEditor` (falls back to a dialog);
- the `prompt.footer.status` recording meter rendering.

## Known limitations

- Hold Space relies on pi-voice's repeat-cadence heuristic on terminals without
  key release events; very slow key-repeat settings will not trigger it. Use the
  toggle there.
- Composer insertion uses `renderer.currentFocusedEditor`, which is not a
  documented plugin API; the dialog fallback is the supported path.
- `transcribe_file` runs wherever the server runs (local by default).
- Native addons are loaded in the plugin process. If a future OpenCode build
  cannot load them, the engine can be moved behind a helper process without
  changing the UI layer.

## Attribution

Engine ported from pi-voice (MIT, Earendil Works contributors). See `LICENSE`.
