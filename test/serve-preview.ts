// Isolated manual-test server: no Discord token, no production data, loopback only.
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { LibraryService } from "../src/library/library-service.js";
import { PlaylistService } from "../src/playlists/playlist-service.js";
import { AccessService } from "../src/access/access-service.js";
import { PlayerManager } from "../src/player/player-manager.js";
import { createAppServer } from "../src/server/app-server.js";
import type { AudioSourceFactory } from "../src/audio/audio-source-factory.js";
import type { ExternalSourceService } from "../src/sources/external-source-service.js";
import type { DiscordBot } from "../src/discord/discord-bot.js";
import type { VoiceConnection } from "@discordjs/voice";
import type { LibraryTrack } from "../src/types.js";

const root = await mkdtemp(path.join(tmpdir(), "sonora-sharing-preview-"));
const library = new LibraryService(path.join(root, "audio"), root); await library.initialize();
const tracks: LibraryTrack[] = [
  { id: "test-theme", title: "Tema de exploração — gravação de teste com um nome bem comprido", relativePath: "music/Campanha/Exploração/tema.wav", category: "music", durationMs: 220_000 },
  { id: "test-combat", title: "Combate", relativePath: "music/Campanha/combate.wav", category: "music", durationMs: 175_000 },
  { id: "test-effect", title: "Trovão de teste", relativePath: "effects/thunder.wav", category: "effect", durationMs: 5_000 },
].map(track => ({ ...track, category: track.category as LibraryTrack["category"], source: "local", modifiedAt: new Date().toISOString(), sizeBytes: 0 }));
await library.importCatalog({ tracks, trash: [] });
const playlists = new PlaylistService(root); await playlists.initialize(); const access = new AccessService(root); await access.initialize();
await playlists.create("Campanha de teste", "Trilha e efeitos", tracks.map(track => track.id));
const players = new PlayerManager({ audioSources: { create: () => { const stream = new PassThrough(); return { stream, dispose: () => stream.destroy() }; } } as unknown as AudioSourceFactory, defaultVolume: 70, defaultEffectVolume: 100, idleTimeoutMs: 0 });
for (const [id, name] of [["111", "Mesa autorizada"], ["222", "Mesa privada"]]) {
  const emitter = new EventEmitter();
  const connection = Object.assign(emitter, { state: { status: "ready" }, subscribe: () => {}, destroy: () => { emitter.emit("destroyed"); } }) as unknown as VoiceConnection;
  players.attachConnection(id!, name!, connection, { id: "voice", name: "Call de teste" });
}
const bot = Object.assign(new EventEmitter(), { getStatus: () => ({ configured: true, connected: true, username: "Prévia isolada" }) }) as unknown as DiscordBot;
const app = await createAppServer({ library, playlists, players, access, bot, externalSources: {} as ExternalSourceService, config: { host: "127.0.0.1", port: 3211, adminToken: "sonora-owner-local-test-only", remoteAccessEnabled: true, publicUrl: "http://localhost:3211", audioDir: path.join(root, "audio"), dataDir: root, ytDlpPath: "yt-dlp", defaultVolume: 70, defaultEffectVolume: 100, idleTimeoutMs: 0, maxUploadBytes: 10 * 1024 * 1024, logLevel: "silent" } });
for (const profile of ["effects", "playback", "full"] as const) { const invite = await access.createInvitation(`Teste ${profile}`, { profile, guildIds: ["111"] }); console.log(`${profile}: http://localhost:3211/invite/${invite.token}`); }
await app.listen({ host: "127.0.0.1", port: 3211 }); console.log("Preview: http://127.0.0.1:3211");
process.once("SIGINT", () => { players.shutdown(); void app.close(); });
