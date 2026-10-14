import { Plugin } from "@opencode/plugin";
import { readSettings } from "./config.js";
import { decodeFileAudio } from "./shared/file-audio.js";
import { TranscriptionService } from "./shared/transcription-service.js";

/**
 * Server-side half of oc-voice. It only registers a tool through the documented
 * plugin API; it never reads or writes OpenCode's own configuration or state.
 * Audio decoding and transcription run locally, exactly like pi-voice.
 */
export default Plugin.define({
  id: "oc-voice.server",
  async setup(context) {
    const service = new TranscriptionService();

    await context.tool.transform((editor) => {
      editor.add({
        name: "transcribe_file",
        description:
          "Transcribe speech from a local audio or video file with oc-voice's configured local speech model. Requires ffmpeg on PATH, or an \"ffmpegPath\" set in oc-voice.json.",
        input: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Local media file path, absolute or relative to the working directory",
            },
          },
          required: ["path"],
          additionalProperties: false,
        },
        execute: async (input, toolContext) => {
          const mediaPath = String((input as { path?: unknown }).path ?? "").trim();
          if (!mediaPath) throw new Error("A media file path is required");

          const result = await readSettings();
          if (!result.settings) {
            throw new Error(
              "oc-voice is not configured. Ask the user to run /voice in the TUI once to choose a local model.",
            );
          }

          const audio = await decodeFileAudio(mediaPath, {
            signal: toolContext.signal,
            ffmpegPath: result.settings.ffmpegPath,
          });
          const text = await service.transcribeFile(result.settings, audio.pcm, toolContext.signal);
          const body = text || `No speech detected in ${audio.seconds.toFixed(1)}s of audio`;
          return { content: [{ type: "text" as const, text: body }] };
        },
      });
    });

    return async () => {
      await service.shutdown();
    };
  },
});
