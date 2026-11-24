import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { ExternalTrack } from "../types.js";

const execFileAsync = promisify(execFile);
const AUDIO_FORMAT = "bestaudio[acodec=opus]/bestaudio[channels<=2]/bestaudio/best";

interface YtDlpInfo {
  id?: string;
  title?: string;
  uploader?: string;
  channel?: string;
  duration?: number;
  webpage_url?: string;
  original_url?: string;
  thumbnail?: string;
  is_live?: boolean;
  entries?: Array<YtDlpInfo | null>;
}

interface SpotifyOEmbed {
  title?: string;
  html?: string;
  thumbnail_url?: string | null;
}

export type ExternalProvider = "youtube" | "spotify";

export interface ExternalStreamCommand {
  command: string;
  args: string[];
}

export interface ExternalSourceOptions {
  ytDlpPath: string;
  cookiesFile?: string;
  fetchImpl?: typeof fetch;
  infoRunner?: (input: string) => Promise<YtDlpInfo>;
}

function providerFromUrl(value: string): ExternalProvider | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const hostname = url.hostname.toLowerCase();
  if (
    hostname === "youtu.be" ||
    hostname === "youtube.com" ||
    hostname.endsWith(".youtube.com")
  ) {
    return "youtube";
  }
  if (
    hostname === "open.spotify.com" ||
    hostname === "spotify.link" ||
    hostname.endsWith(".spotify.link")
  ) {
    return "spotify";
  }
  return null;
}

function firstVideo(info: YtDlpInfo): YtDlpInfo {
  if (!info.entries) return info;
  const entry = info.entries.find(
    (candidate): candidate is YtDlpInfo => Boolean(candidate?.id && candidate?.title),
  );
  if (!entry) throw new Error("Nenhum resultado de video foi encontrado.");
  return entry;
}

function youtubeVideoUrl(input: string): string {
  const url = new URL(input);
  const parts = url.pathname.split("/").filter(Boolean);
  const videoId = url.hostname === "youtu.be"
    ? (parts.length === 1 ? parts[0] : undefined)
    : url.pathname === "/watch"
      ? url.searchParams.get("v")
      : ["shorts", "embed", "live"].includes(parts[0] ?? "") && parts.length === 2
        ? parts[1]
        : undefined;
  if (!videoId || !/^[\w-]+$/.test(videoId)) {
    throw new Error("Use o link de um video individual do YouTube; playlists e canais nao sao suportados.");
  }
  // Discard playlist, timestamp and sharing parameters before giving the URL to yt-dlp.
  return `https://www.youtube.com/watch?v=${videoId}`;
}

export function describeYtDlpError(error: unknown): string {
  const details = error as { code?: unknown; killed?: boolean; stderr?: unknown; message?: unknown } | null;
  const message = typeof details?.stderr === "string" && details.stderr.trim()
    ? details.stderr.trim()
    : typeof details?.message === "string" ? details.message : String(error);
  if (details?.code === "ENOENT") return "yt-dlp nao foi encontrado. Verifique YTDLP_PATH.";
  if (details?.killed) return "A consulta excedeu o tempo limite. Verifique a conexao e tente novamente.";
  if (/429|too many requests|sign in to confirm.*not a bot/i.test(message)) {
    return "O YouTube limitou ou bloqueou esta conexao (verificacao anti-bot). Aguarde antes de tentar novamente; nao e uma falha do arquivo de audio.";
  }
  if (/no such option: --js-runtimes/i.test(message)) {
    return "O yt-dlp instalado esta desatualizado. Atualize-o para uma versao com suporte a JavaScript/EJS.";
  }
  if (/javascript runtime|challenge solving|signature solving|yt_dlp_ejs|yt-dlp-ejs/i.test(message)) {
    return "O yt-dlp nao conseguiu resolver o desafio JavaScript do YouTube. Atualize yt-dlp e seu componente EJS; o bot utiliza o Node instalado.";
  }
  // Do not expose the execFile command (including cookie-file paths) in the dashboard.
  const lines = message.split("\n").filter((line) => line.trim() && !/^Command failed:/i.test(line));
  return (lines.filter((line) => /^ERROR:/i.test(line)).at(-1) ?? lines.at(-1) ?? "O processo yt-dlp falhou sem fornecer detalhes.")
    .replace(/^ERROR:\s*/i, "").slice(0, 1_000);
}

export class ExternalSourceService {
  private readonly fetchImpl: typeof fetch;
  private readonly infoRunner: (input: string) => Promise<YtDlpInfo>;

  constructor(private readonly options: ExternalSourceOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.infoRunner = options.infoRunner ?? ((input) => this.runYtDlpInfo(input));
  }

  providerFor(value: string): ExternalProvider | null {
    return providerFromUrl(value.trim());
  }

  isSupportedUrl(value: string): boolean {
    return this.providerFor(value) !== null;
  }

  async resolve(value: string): Promise<ExternalTrack> {
    const input = value.trim();
    const provider = this.providerFor(input);
    if (provider === "youtube") return this.resolveYoutube(youtubeVideoUrl(input), input, "youtube");
    if (provider === "spotify") return this.resolveSpotify(input);
    throw new Error("Use um link do YouTube ou de uma faixa do Spotify.");
  }

  streamCommand(track: ExternalTrack): ExternalStreamCommand {
    return {
      command: this.options.ytDlpPath,
      args: [
        ...this.commonArgs(),
        "--fragment-retries",
        "2",
        "--abort-on-unavailable-fragments",
        "-o",
        "-",
        "--",
        track.webpageUrl,
      ],
    };
  }

  private async resolveSpotify(input: string): Promise<ExternalTrack> {
    const spotifyUrl = new URL(input);
    if (spotifyUrl.hostname === "open.spotify.com") {
      const parts = spotifyUrl.pathname.split("/").filter(Boolean);
      if (/^intl-[a-z-]+$/i.test(parts[0] ?? "")) parts.shift();
      if (parts[0] !== "track" || parts.length !== 2) {
        throw new Error("Nesta versao, links do Spotify devem apontar para uma faixa.");
      }
      spotifyUrl.pathname = `/track/${parts[1]}`;
      spotifyUrl.search = "";
      spotifyUrl.hash = "";
    }

    const endpoint = new URL("https://open.spotify.com/oembed");
    endpoint.searchParams.set("url", spotifyUrl.toString());
    let response: Response;
    try {
      response = await this.fetchImpl(endpoint, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(12_000),
      });
    } catch (error) {
      throw new Error(`Nao foi possivel consultar o Spotify: ${(error as Error).message}`);
    }
    if (!response.ok) {
      throw new Error(`O Spotify recusou o link (HTTP ${response.status}).`);
    }

    const metadata = (await response.json()) as SpotifyOEmbed;
    const entityType = metadata.html?.match(/\/embed\/([^/?"']+)/i)?.[1];
    if (entityType && entityType !== "track") {
      throw new Error("Nesta versao, links do Spotify devem apontar para uma faixa.");
    }
    const title = metadata.title?.trim();
    if (!title) throw new Error("O Spotify nao retornou o titulo da faixa.");

    const result = await this.resolveYoutube(
      `ytsearch1:${title} official audio`,
      input,
      "spotify",
    );
    return {
      ...result,
      originalUrl: input,
      resolvedFrom: "spotify",
      ...(metadata.thumbnail_url ? { thumbnailUrl: metadata.thumbnail_url } : {}),
    };
  }

  private async resolveYoutube(
    lookup: string,
    originalUrl: string,
    resolvedFrom: "youtube" | "spotify",
  ): Promise<ExternalTrack> {
    let raw: YtDlpInfo;
    try {
      raw = await this.infoRunner(lookup);
    } catch (error) {
      throw new Error(`Nao foi possivel consultar o YouTube: ${describeYtDlpError(error)}`);
    }
    const info = firstVideo(raw);
    if (!info.id || !info.title) throw new Error("O YouTube retornou metadados incompletos.");
    if (info.is_live) throw new Error("Transmissoes ao vivo ainda nao sao suportadas.");
    const webpageUrl = info.webpage_url ?? info.original_url;
    if (!webpageUrl) throw new Error("O YouTube nao retornou um endereco reproduzivel.");

    return {
      id: `youtube:${info.id}`,
      source: "youtube",
      category: "music",
      title: info.title,
      ...(info.uploader ?? info.channel
        ? { artist: (info.uploader ?? info.channel) as string }
        : {}),
      ...(typeof info.duration === "number" && info.duration > 0
        ? { durationMs: Math.round(info.duration * 1_000) }
        : {}),
      ...(info.thumbnail ? { thumbnailUrl: info.thumbnail } : {}),
      webpageUrl,
      originalUrl,
      resolvedFrom,
    };
  }

  private async runYtDlpInfo(input: string): Promise<YtDlpInfo> {
    const { stdout } = await execFileAsync(
      this.options.ytDlpPath,
      [
        ...this.commonArgs(),
        "--dump-single-json",
        "--",
        input,
      ],
      { timeout: 45_000, maxBuffer: 8 * 1024 * 1024 },
    );
    return JSON.parse(stdout) as YtDlpInfo;
  }

  private cookieArgs(): string[] {
    return this.options.cookiesFile ? ["--cookies", this.options.cookiesFile] : [];
  }

  private commonArgs(): string[] {
    return [
      // User-wide download/archive/postprocessing settings must not affect the pipe.
      "--ignore-config",
      "--no-playlist",
      "--no-progress",
      "--socket-timeout", "15",
      "--retries", "2",
      "--extractor-retries", "2",
      // Node is already required by Sonora; yt-dlp only enables Deno by default.
      "--js-runtimes", `node:${process.execPath}`,
      ...this.youtubeClientArgs(),
      ...this.cookieArgs(),
      "-f", AUDIO_FORMAT,
    ];
  }

  private youtubeClientArgs(): string[] {
    return this.options.cookiesFile
      ? []
      : ["--extractor-args", "youtube:player_client=web_embedded,android_vr"];
  }
}
