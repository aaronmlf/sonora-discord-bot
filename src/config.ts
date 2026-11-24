import "dotenv/config";

import path from "node:path";
import { z } from "zod";

const optionalTrimmedString = z.preprocess(
  (value) =>
    typeof value === "string" && value.trim() === "" ? undefined : value,
  z.string().trim().optional(),
);

const optionalAdminToken = z.preprocess(
  (value) =>
    typeof value === "string" && value.trim() === "" ? undefined : value,
  z.string().trim().min(12).optional(),
);

const envSchema = z.object({
  DISCORD_TOKEN: optionalTrimmedString,
  DISCORD_CLIENT_ID: optionalTrimmedString,
  DISCORD_GUILD_ID: optionalTrimmedString,
  HOST: z.string().trim().default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3210),
  ADMIN_TOKEN: optionalAdminToken,
  REMOTE_ACCESS_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  PUBLIC_URL: optionalTrimmedString,
  AUDIO_DIR: z.string().trim().default("./data/audio"),
  DATA_DIR: z.string().trim().default("./data"),
  YTDLP_PATH: z.string().trim().default("yt-dlp"),
  YTDLP_COOKIES_FILE: optionalTrimmedString,
  DEFAULT_VOLUME: z.coerce.number().int().min(0).max(100).default(70),
  DEFAULT_EFFECT_VOLUME: z.coerce.number().int().min(0).max(150).default(100),
  IDLE_TIMEOUT_SECONDS: z.coerce.number().int().min(0).default(300),
  MAX_UPLOAD_MB: z.coerce.number().int().min(1).max(2_048).default(100),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
});

export interface AppConfig {
  discordToken?: string;
  discordClientId?: string;
  discordGuildId?: string;
  host: string;
  port: number;
  adminToken?: string;
  remoteAccessEnabled: boolean;
  publicUrl?: string;
  audioDir: string;
  dataDir: string;
  ytDlpPath: string;
  ytDlpCookiesFile?: string;
  defaultVolume: number;
  defaultEffectVolume: number;
  idleTimeoutMs: number;
  maxUploadBytes: number;
  logLevel: z.infer<typeof envSchema>["LOG_LEVEL"];
}

function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

function isHttpsOrigin(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      Boolean(url.hostname) &&
      (url.pathname === "/" || url.pathname === "") &&
      !url.search &&
      !url.hash &&
      !url.username &&
      !url.password;
  } catch {
    return false;
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.parse(env);

  if (!isLoopback(parsed.HOST) && !parsed.ADMIN_TOKEN) {
    throw new Error(
      "ADMIN_TOKEN deve ser definido quando o painel nao estiver limitado a localhost.",
    );
  }

  if (parsed.REMOTE_ACCESS_ENABLED) {
    if (!parsed.ADMIN_TOKEN || parsed.ADMIN_TOKEN.length < 32) {
      throw new Error(
        "ADMIN_TOKEN deve ter pelo menos 32 caracteres quando o acesso remoto estiver ativo.",
      );
    }
    if (!isHttpsOrigin(parsed.PUBLIC_URL)) {
      throw new Error(
        "PUBLIC_URL deve ser uma origem HTTPS valida quando o acesso remoto estiver ativo.",
      );
    }
  }

  const config: AppConfig = {
    host: parsed.HOST,
    port: parsed.PORT,
    remoteAccessEnabled: parsed.REMOTE_ACCESS_ENABLED,
    audioDir: path.resolve(parsed.AUDIO_DIR),
    dataDir: path.resolve(parsed.DATA_DIR),
    ytDlpPath: parsed.YTDLP_PATH,
    defaultVolume: parsed.DEFAULT_VOLUME,
    defaultEffectVolume: parsed.DEFAULT_EFFECT_VOLUME,
    idleTimeoutMs: parsed.IDLE_TIMEOUT_SECONDS * 1_000,
    maxUploadBytes: parsed.MAX_UPLOAD_MB * 1024 * 1024,
    logLevel: parsed.LOG_LEVEL,
  };

  if (parsed.DISCORD_TOKEN) config.discordToken = parsed.DISCORD_TOKEN;
  if (parsed.DISCORD_CLIENT_ID) config.discordClientId = parsed.DISCORD_CLIENT_ID;
  if (parsed.DISCORD_GUILD_ID) config.discordGuildId = parsed.DISCORD_GUILD_ID;
  if (parsed.ADMIN_TOKEN) config.adminToken = parsed.ADMIN_TOKEN;
  if (parsed.PUBLIC_URL) {
    config.publicUrl = parsed.PUBLIC_URL.replace(/\/+$/, "");
  }
  if (parsed.YTDLP_COOKIES_FILE) {
    config.ytDlpCookiesFile = path.resolve(parsed.YTDLP_COOKIES_FILE);
  }

  return config;
}
