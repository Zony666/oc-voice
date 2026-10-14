# oc-voice — local speech-to-text for OpenCode

Local dictation for [OpenCode](https://opencode.ai) V2. Press the shortcut (or hold
**Space**), speak, and oc-voice records from your microphone, transcribes the audio
locally with a speech model, and inserts the text into the prompt for review — it is
never auto-sent.

Everything runs on your machine. Speech models are open GGUF models from Hugging
Face (Qwen3-ASR, SenseVoice, Voxtral, and others); `/voice` downloads the one you
pick into the standard Hugging Face cache. No audio or transcript leaves your
computer.

A port of [pi-voice](https://github.com/earendil-works/pi-voice) (MIT, Earendil
Works contributors) to OpenCode's plugin API.

## Requirements

- OpenCode V2
- Node 22+
- `ffmpeg` for the `transcribe_file` tool, when it is not on `PATH` (see
  `ffmpegPath` below)

## Install

Install the repository as a global plugin:

```sh
opencode plugin add github:zeyov/oc-voice
```

OpenCode installs the package and loads both entrypoints — the server plugin (the
`transcribe_file` tool) and the CLI/TUI plugin (the microphone and UI). Pin a
branch, tag, or commit with `#`, for example
`opencode plugin add github:zeyov/oc-voice#main`.

### From a local checkout

To run from a clone instead, point OpenCode at the checkout directory.

The CLI/TUI plugin owns the microphone and the UI and runs locally, so it also
works against a remote server. Add the checkout to `cli.json`:

```json
{
  "plugins": ["/path/to/oc-voice"]
}
```

Or try it without editing your global config:

```sh
OPENCODE_CLI_CONFIG_CONTENT='{"plugins":["/path/to/oc-voice"]}' opencode
```

The server plugin (the `transcribe_file` tool) is loaded from `opencode.json(c)`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["/path/to/oc-voice"]
}
```

Reload OpenCode after changing the source.

## Usage

- **Toggle**: press the shortcut (default `Ctrl+Alt+Z`). Change the binding for
  `oc-voice.toggle` in `cli.json` keybinds.
- **Hold Space**: enable it in `/voice` → **Voice input mode** → **Hold Space**,
  then hold Space in the prompt. Releasing transcribes.
- **Escape**: discard the current recording while it is active.
- **`/voice`**: configure the model (with download), transcription language,
  input mode, microphone, model retention, and Chinese output.
- **`transcribe_file`**: agent tool for transcribing local audio/video files.

While recording, a spinner and elapsed time appear in the prompt footer. The
transcript is inserted at the prompt cursor for review; if the composer cannot be
reached, oc-voice falls back to a prefilled dialog and sends on Enter.

## Configuration

oc-voice stores its settings in OpenCode's config directory
(`~/.config/opencode`, honoring `XDG_CONFIG_HOME`):

- `oc-voice.json` — settings

Most settings are written by `/voice`; the file is safe to edit by hand. It also
accepts:

| Field | Meaning |
| --- | --- |
| `ffmpegPath` | Path to the `ffmpeg` executable for `transcribe_file`. Defaults to `OC_VOICE_FFMPEG_PATH`, then `ffmpeg` on `PATH`. |

Models are stored in the standard Hugging Face cache (`HF_HUB_CACHE` / `HF_HOME`
respected).

## License

MIT. See `LICENSE`.
