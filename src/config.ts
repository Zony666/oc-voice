import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  getCatalogModel,
  languageIdentity,
} from "./shared/catalog.js";
import { DEFAULT_SHORTCUT, normalizeShortcut } from "./shared/shortcut-core.js";
import {
  defaultChineseOutput,
  transcriptionLanguageForModel,
  type ChineseOutput,
  type MicrophoneSetting,
  type TranscribeSettings,
} from "./shared/settings.js";

const SETTINGS_VERSION = 1;

/**
 * Configuration is owned by op-voice and lives outside OpenCode, so nothing in
 * OpenCode's own config or database is touched. Set OP_VOICE_CONFIG_DIR to move
 * it (handy for tests and for a project-local setup).
 */
export function configDir(): string {
  const override = process.env.OP_VOICE_CONFIG_DIR?.trim();
  if (override) return override;
  if (process.platform === "win32") {
    const appData = process.env.APPDATA?.trim();
    if (appData) return join(appData, "op-voice");
  }
  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  return join(xdg && xdg.length > 0 ? xdg : join(homedir(), ".config"), "op-voice");
}

export function settingsPath(): string {
  return join(configDir(), "settings.json");
}

export function logPath(): string {
  return join(configDir(), "op-voice.log");
}

type SettingsReadResult = {
  settings?: TranscribeSettings;
  warning?: string;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeLanguages(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || !value.every((language) => typeof language === "string")) {
    return undefined;
  }
  const languages = [...new Set(value.map(languageIdentity).filter(Boolean))];
  return languages.length > 0 ? languages : undefined;
}

function validateChineseOutput(value: unknown): ChineseOutput {
  return value === "simplified" ||
    value === "traditional-taiwan" ||
    value === "traditional-hong-kong"
    ? value
    : defaultChineseOutput();
}

function validateMicrophone(value: unknown): MicrophoneSetting | undefined {
  if (!isObject(value)) return undefined;
  if (value.type === "system-default") return { type: "system-default" };
  if (
    value.type !== "device" ||
    typeof value.name !== "string" ||
    !value.name.trim() ||
    !Number.isInteger(value.occurrence) ||
    (value.occurrence as number) < 0
  ) {
    return undefined;
  }
  return { type: "device", name: value.name, occurrence: value.occurrence as number };
}

export function validateSettings(value: unknown): TranscribeSettings | undefined {
  if (!isObject(value) || value.version !== SETTINGS_VERSION) return undefined;
  if (!isObject(value.backend) || value.backend.type !== "transcribe-cpp") return undefined;
  const shortcut =
    typeof value.shortcut === "string" ? normalizeShortcut(value.shortcut) : undefined;
  if (!shortcut) return undefined;
  if (!isObject(value.model) || value.model.source !== "catalog") return undefined;
  if (typeof value.model.id !== "string") return undefined;
  const model = getCatalogModel(value.model.id);
  if (!model) return undefined;
  if (typeof value.model.path !== "string" || value.model.path.length === 0) return undefined;

  const preferredLanguages = normalizeLanguages(value.preferredLanguages);
  const microphone = validateMicrophone(value.microphone);
  if (!preferredLanguages || !microphone) return undefined;

  return {
    version: SETTINGS_VERSION,
    backend: { type: "transcribe-cpp" },
    shortcut,
    inputMode: value.inputMode === "hold-space" ? "hold-space" : "toggle",
    keepModelLoaded: typeof value.keepModelLoaded === "boolean" ? value.keepModelLoaded : true,
    preferredLanguages,
    transcriptionLanguage: transcriptionLanguageForModel(
      value.transcriptionLanguage,
      model,
      preferredLanguages,
    ),
    chineseOutput: validateChineseOutput(value.chineseOutput),
    microphone,
    model: { source: "catalog", id: value.model.id, path: value.model.path },
  };
}

export async function readSettings(): Promise<SettingsReadResult> {
  const path = settingsPath();
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    const settings = validateSettings(parsed);
    return settings
      ? { settings }
      : { warning: `Invalid settings in ${path}; run /voice to configure.` };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    return {
      warning: `Could not read ${path}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export async function writeSettings(settings: TranscribeSettings): Promise<void> {
  const path = settingsPath();
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  const content = `${JSON.stringify(settings, null, 2)}\n`;
  try {
    await writeFile(temporaryPath, content, { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, path);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

export { DEFAULT_SHORTCUT };
