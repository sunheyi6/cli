import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type SunCliConfig = {
  model: string;
  apiBaseUrl: string;
  apiKeyEnv: string;
  apiKey?: string;
};

const DEFAULT_CONFIG: SunCliConfig = {
  model: "deepseek-chat",
  apiBaseUrl: "https://api.deepseek.com",
  apiKeyEnv: "DEEPSEEK_API_KEY",
};

const CONFIG_PATH = join(homedir(), ".suncli", "config.json");

export function getConfigPath(): string {
  return CONFIG_PATH;
}

export function loadConfig(): SunCliConfig {
  try {
    const content = readFileSync(CONFIG_PATH, "utf8");
    const parsed = JSON.parse(content) as Partial<SunCliConfig>;
    return {
      model: parsed.model ?? DEFAULT_CONFIG.model,
      apiBaseUrl: parsed.apiBaseUrl ?? DEFAULT_CONFIG.apiBaseUrl,
      apiKeyEnv: parsed.apiKeyEnv ?? DEFAULT_CONFIG.apiKeyEnv,
      apiKey: parsed.apiKey,
    };
  } catch {
    return DEFAULT_CONFIG;
  }
}

export function saveConfig(partial: Partial<SunCliConfig>): SunCliConfig {
  const merged = { ...loadConfig(), ...partial };
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2), "utf8");
  return merged;
}
