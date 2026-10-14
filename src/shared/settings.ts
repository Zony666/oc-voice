import {
  languageIdentity,
  getCatalogModel,
  resolveModelLanguage,
  type CatalogModel,
} from "./catalog.js";
import { DEFAULT_SHORTCUT } from "./shortcut-core.js";

export type MicrophoneSetting =
  | { type: "system-default" }
  | { type: "device"; name: string; occurrence: number };

export const DEFAULT_MICROPHONE: MicrophoneSetting = { type: "system-default" };

export type ChineseOutput =
  | "simplified"
  | "traditional-taiwan"
  | "traditional-hong-kong";

export function defaultChineseOutput(): ChineseOutput {
  const locale = Intl.DateTimeFormat().resolvedOptions().locale;
  const subtags = locale.toLowerCase().split("-");
  if (subtags.includes("hk") || subtags.includes("mo")) return "traditional-hong-kong";
  if (subtags.includes("tw") || subtags.includes("hant")) return "traditional-taiwan";
  return "simplified";
}

/** "auto" asks a capable model to detect the language; otherwise this is a language code. */
export type TranscriptionLanguage = string;

export type InputMode = "toggle" | "hold-space";

export type TranscribeSettings = {
  version: 1;
  backend: { type: "transcribe-cpp" };
  shortcut: string;
  inputMode: InputMode;
  keepModelLoaded: boolean;
  preferredLanguages: string[];
  transcriptionLanguage: TranscriptionLanguage;
  chineseOutput: ChineseOutput;
  microphone: MicrophoneSetting;
  model: {
    source: "catalog";
    id: string;
    path: string;
  };
};

function defaultTranscriptionLanguage(
  model: CatalogModel,
  preferredLanguages: readonly string[] = [],
): TranscriptionLanguage {
  if (model.capabilities.languageDetection) return "auto";
  for (const language of preferredLanguages) {
    const code = resolveModelLanguage(model, language);
    if (code) return code;
  }
  return model.languages[0] ?? "en";
}

/** Keep an exact model language when possible; otherwise choose a safe default. */
export function transcriptionLanguageForModel(
  value: unknown,
  model: CatalogModel,
  preferredLanguages: readonly string[] = [],
): TranscriptionLanguage {
  if (typeof value === "string") {
    if (value === "auto" && model.capabilities.languageDetection) return value;
    if (value !== "auto") {
      const code = resolveModelLanguage(model, value);
      if (code) return code;
    }
  }
  return defaultTranscriptionLanguage(model, preferredLanguages);
}

type ModelSettingsOptions = {
  shortcut?: string;
  inputMode?: InputMode;
  keepModelLoaded?: boolean;
  preferredLanguages?: readonly string[];
  transcriptionLanguage?: TranscriptionLanguage;
  chineseOutput?: ChineseOutput;
  microphone?: MicrophoneSetting;
};

export function settingsForModel(
  modelId: string,
  modelPath: string,
  options: ModelSettingsOptions = {},
): TranscribeSettings {
  const model = getCatalogModel(modelId);
  if (!model) throw new Error(`Unknown catalog model: ${modelId}`);
  const preferredLanguages = [
    ...new Set((options.preferredLanguages ?? ["en"]).map(languageIdentity)),
  ];
  return {
    version: 1,
    backend: { type: "transcribe-cpp" },
    shortcut: options.shortcut ?? DEFAULT_SHORTCUT,
    inputMode: options.inputMode ?? "toggle",
    keepModelLoaded: options.keepModelLoaded ?? true,
    preferredLanguages,
    transcriptionLanguage: transcriptionLanguageForModel(
      options.transcriptionLanguage,
      model,
      preferredLanguages,
    ),
    chineseOutput: options.chineseOutput ?? defaultChineseOutput(),
    microphone: { ...(options.microphone ?? DEFAULT_MICROPHONE) },
    model: { source: "catalog", id: modelId, path: modelPath },
  };
}
