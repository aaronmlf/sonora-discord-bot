import { mkdir } from "node:fs/promises";

import { loadConfig } from "./config.js";
import { AccessService } from "./access/access-service.js";
import { AudioSourceFactory } from "./audio/audio-source-factory.js";
import { DiscordBot } from "./discord/discord-bot.js";
import { LibraryService } from "./library/library-service.js";
import { PlayerManager } from "./player/player-manager.js";
import { PlaylistService } from "./playlists/playlist-service.js";
import { createAppServer } from "./server/app-server.js";
import { ExternalSourceService } from "./sources/external-source-service.js";

const config = loadConfig();
await mkdir(config.dataDir, { recursive: true });
await mkdir(config.audioDir, { recursive: true });

const library = new LibraryService(config.audioDir, config.dataDir);
await library.initialize(false);
const playlists = new PlaylistService(config.dataDir);
await playlists.initialize();
const access = new AccessService(config.dataDir);
await access.initialize();

const externalSources = new ExternalSourceService({
  ytDlpPath: config.ytDlpPath,
  ...(config.ytDlpCookiesFile ? { cookiesFile: config.ytDlpCookiesFile } : {}),
});
const audioSources = new AudioSourceFactory(library, externalSources);

const players = new PlayerManager({
  dataDir: config.dataDir,
  audioSources,
  defaultVolume: config.defaultVolume,
  defaultEffectVolume: config.defaultEffectVolume,
  idleTimeoutMs: config.idleTimeoutMs,
});
await players.initialize();
const bot = new DiscordBot(config, library, externalSources, players);
const server = await createAppServer({
  config,
  library,
  playlists,
  access,
  externalSources,
  players,
  bot,
});

await server.listen({ host: config.host, port: config.port });
// Use the same reconciliation as a manual scan: open dashboards and queued
// tracks must see moves discovered after the server has started listening.
void server.scanLibrary().catch(() => server.log.error("Falha ao indexar biblioteca. Verifique permissões das pastas."));
void bot.start().catch((error) => {
  server.log.error({ error }, "Falha ao conectar o bot ao Discord");
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  server.log.info({ signal }, "Encerrando o Sonora");
  try {
    players.shutdown();
    await players.flush();
  } catch (error) {
    process.exitCode = 1;
    server.log.error({ err: error }, "Falha ao salvar a fila durante o encerramento");
  }
  const stopped = await Promise.allSettled([bot.stop(), server.close()]);
  for (const result of stopped) {
    if (result.status === "rejected") {
      process.exitCode = 1;
      server.log.error({ err: result.reason }, "Falha ao encerrar o Sonora");
    }
  }
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
