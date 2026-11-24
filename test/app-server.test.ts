import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import type { FastifyInstance } from "fastify";

import { AccessService } from "../src/access/access-service.js";
import type { AudioSourceFactory } from "../src/audio/audio-source-factory.js";
import type { AppConfig } from "../src/config.js";
import type { DiscordBot } from "../src/discord/discord-bot.js";
import { LibraryService } from "../src/library/library-service.js";
import type { GuildPlayer } from "../src/player/guild-player.js";
import { PlayerManager } from "../src/player/player-manager.js";
import { PlaylistService } from "../src/playlists/playlist-service.js";
import { createAppServer } from "../src/server/app-server.js";
import type { ExternalSourceService } from "../src/sources/external-source-service.js";
import type { ExternalTrack } from "../src/types.js";

function silentWav(): Buffer {
  const dataSize = 1_600;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(8_000, 24);
  buffer.writeUInt32LE(16_000, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);
  return buffer;
}

describe("AppServer", () => {
  it("expoe o fluxo completo de edicao, playlists e exclusao", async () => {
    const temporaryRoot = await mkdtemp(path.join(tmpdir(), "sonora-api-"));
    const audioDir = path.join(temporaryRoot, "audio");
    const dataDir = path.join(temporaryRoot, "data");
    const audioPath = path.join(audioDir, "music", "faixa.wav");
    let app: FastifyInstance | undefined;

    try {
      await mkdir(path.dirname(audioPath), { recursive: true });
      await writeFile(audioPath, silentWav());
      const library = new LibraryService(audioDir, dataDir);
      await library.initialize();
      const playlists = new PlaylistService(dataDir);
      await playlists.initialize();
      const access = new AccessService(dataDir);
      await access.initialize();
      const players = new PlayerManager({
        audioSources: {} as AudioSourceFactory,
        defaultVolume: 70,
        defaultEffectVolume: 100,
        idleTimeoutMs: 0,
      });
      const bot = Object.assign(new EventEmitter(), {
        getStatus: () => ({ configured: false, connected: false, username: null }),
      }) as unknown as DiscordBot;
      const config: AppConfig = {
        host: "127.0.0.1",
        port: 3210,
        remoteAccessEnabled: false,
        audioDir,
        dataDir,
        ytDlpPath: "yt-dlp",
        defaultVolume: 70,
        defaultEffectVolume: 100,
        idleTimeoutMs: 0,
        maxUploadBytes: 10 * 1024 * 1024,
        logLevel: "silent",
      };
      app = await createAppServer({
        config,
        library,
        playlists,
        access,
        players,
        bot,
        externalSources: {} as ExternalSourceService,
      });

      const track = library.list()[0];
      assert.ok(track);
      const edited = await app.inject({
        method: "PATCH",
        url: `/api/library/${track.id}`,
        payload: { title: "Faixa da mesa", category: "effect" },
      });
      assert.equal(edited.statusCode, 200);
      assert.equal(edited.json().track.title, "Faixa da mesa");

      const created = await app.inject({
        method: "POST",
        url: "/api/playlists",
        payload: { name: "Combate", description: "Trilha e efeitos" },
      });
      assert.equal(created.statusCode, 201);
      const playlistId = created.json().playlist.id as string;
      const added = await app.inject({
        method: "POST",
        url: `/api/playlists/${playlistId}/items`,
        payload: { trackId: track.id },
      });
      assert.equal(added.statusCode, 201);
      assert.equal(added.json().playlist.items.length, 1);

      const state = await app.inject({ method: "GET", url: "/api/state" });
      assert.equal(state.json().playlists[0].name, "Combate");

      const rejected = await app.inject({ method: "POST", url: "/api/playlists", payload: { name: "Ausente", trackId: "missing" } });
      assert.equal(rejected.statusCode, 404);
      assert.equal(playlists.list().length, 1);
      const seeded = await app.inject({ method: "POST", url: "/api/playlists", payload: { name: "Coleção", trackId: track.id } });
      assert.equal(seeded.statusCode, 201);
      assert.equal(seeded.json().playlist.items[0].trackId, track.id);

      const deleted = await app.inject({
        method: "DELETE",
        url: `/api/library/${track.id}`,
      });
      assert.equal(deleted.statusCode, 200);
      assert.equal(deleted.json().tracks.length, 0);
      assert.equal(deleted.json().playlists[0].items.length, 1);
      const trash = await app.inject({ method: "GET", url: "/api/studio" });
      assert.equal(trash.json().trash.length, 1);
      await app.inject({ method: "POST", url: "/api/library/scan" });
      const restored = await app.inject({ method: "POST", url: "/api/studio/library", payload: { action: "restore", trackId: track.id } });
      assert.equal(restored.statusCode, 200);
      assert.equal(library.get(track.id)?.title, "Faixa da mesa");
      assert.equal(playlists.get(playlistId)?.items[0]?.trackId, track.id);
      const preview = await app.inject({ method: "GET", url: `/api/library/${track.id}/preview`, headers: { range: "bytes=0-43" } });
      assert.equal(preview.statusCode, 206);
      assert.equal(preview.rawPayload.length, 44);
      assert.equal(players.list().length, 0, "Preview must never create a Discord player");
      const folder = await app.inject({ method: "POST", url: "/api/studio/library", payload: { action: "folder", folder: "effects/Combate" } });
      assert.equal(folder.statusCode, 200);
      const moved = await app.inject({ method: "POST", url: "/api/studio/library", payload: { action: "move", trackId: track.id, folder: "effects/Combate" } });
      assert.equal(moved.statusCode, 200);
      assert.equal(playlists.get(playlistId)?.items[0]?.trackId, track.id);
      const scene = await app.inject({ method: "POST", url: "/api/scenes", payload: { scene: { name: "Combate", playlistId, environments: [{ trackId: track.id, volume: 40 }], effectIds: [track.id] } } });
      assert.equal(scene.statusCode, 200);
      assert.equal(scene.json().scene.transitionMs, 2000);
      const invalidScene = await app.inject({ method: "POST", url: "/api/scenes", payload: { scene: { name: "Inválida", environments: Array(4).fill({ trackId: track.id, volume: 50 }) } } });
      assert.equal(invalidScene.statusCode, 400);
      const exported = await app.inject({ method: "POST", url: "/api/backups/export", payload: { includeAudio: true } });
      assert.equal(exported.statusCode, 200);
      await library.update(track.id, { title: "Mudança posterior" });
      const boundary = "sonora-backup-test-boundary";
      const payload = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="backup.sonora.gz"\r\nContent-Type: application/gzip\r\n\r\n`), exported.rawPayload, Buffer.from(`\r\n--${boundary}--\r\n`)]);
      const restoredBackup = await app.inject({ method: "POST", url: "/api/backups/restore", headers: { "content-type": `multipart/form-data; boundary=${boundary}`, "x-sonora-confirm": "restore" }, payload });
      assert.equal(restoredBackup.statusCode, 200, restoredBackup.body);
      assert.equal(library.get(track.id)?.title, "Faixa da mesa");
    } finally {
      if (app) await app.close();
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("adiciona uma pasta inteira a fila e aceita shuffle", async () => {
    const temporaryRoot = await mkdtemp(path.join(tmpdir(), "sonora-folder-api-"));
    const audioDir = path.join(temporaryRoot, "audio");
    const dataDir = path.join(temporaryRoot, "data");
    let app: FastifyInstance | undefined;

    try {
      const folder = path.join(audioDir, "music", "Campanha");
      await mkdir(folder, { recursive: true });
      await writeFile(path.join(folder, "abertura.wav"), silentWav());
      await writeFile(path.join(folder, "combate.wav"), silentWav());
      const library = new LibraryService(audioDir, dataDir);
      await library.initialize();
      const playlists = new PlaylistService(dataDir);
      await playlists.initialize();
      const access = new AccessService(dataDir);
      await access.initialize();
      const enqueuedIds: string[] = [];
      let voiceChannelId: string | undefined = "voice-1";
      const snapshot = () => ({
        guildId: "guild-1",
        guildName: "Mesa",
        voiceChannelId,
        voiceChannelName: "Geral",
        status: "idle" as const,
        current: null,
        upcoming: [],
        repeatMode: "off" as const,
        volume: 70,
        effectVolume: 100,
        activeEffects: [],
        startedAt: null,
        pausedAt: null,
        error: null,
      });
      const guildPlayer = {
        getSnapshot: snapshot,
        enqueue: ({ id }: { id: string }) => enqueuedIds.push(id),
        enqueueMany: (tracks: Array<{ id: string }>) => {
          enqueuedIds.push(...tracks.map(({ id }) => id));
        },
      } as unknown as GuildPlayer;
      const players = Object.assign(new EventEmitter(), {
        list: () => [snapshot()],
        get: (guildId: string) => guildId === "guild-1" ? guildPlayer : null,
        removeTrack: () => undefined,
        updateTrack: () => undefined,
      }) as unknown as PlayerManager;
      const bot = Object.assign(new EventEmitter(), {
        getStatus: () => ({ configured: false, connected: false, username: null }),
      }) as unknown as DiscordBot;
      const config: AppConfig = {
        host: "127.0.0.1",
        port: 3210,
        remoteAccessEnabled: false,
        audioDir,
        dataDir,
        ytDlpPath: "yt-dlp",
        defaultVolume: 70,
        defaultEffectVolume: 100,
        idleTimeoutMs: 0,
        maxUploadBytes: 10 * 1024 * 1024,
        logLevel: "silent",
      };
      app = await createAppServer({
        config,
        library,
        playlists,
        access,
        players,
        bot,
        externalSources: { resolve: async (url: string) => {
          // The Discord session changes while yt-dlp is resolving a link.
          voiceChannelId = "voice-2";
          return { id: "youtube-test", title: "Link de teste", source: "youtube", category: "music", webpageUrl: url, originalUrl: url, resolvedFrom: "youtube" } satisfies ExternalTrack;
        } } as ExternalSourceService,
      });

      const trackIds = library.list().map(({ id }) => id);
      const ordered = await app.inject({
        method: "POST",
        url: "/api/sessions/guild-1/queue/batch",
        payload: { trackIds, shuffle: false },
      });
      assert.equal(ordered.statusCode, 200);
      assert.equal(ordered.json().added, 2);
      assert.deepEqual(enqueuedIds, trackIds);

      enqueuedIds.length = 0;
      const shuffled = await app.inject({
        method: "POST",
        url: "/api/sessions/guild-1/queue/batch",
        payload: { trackIds, shuffle: true },
      });
      assert.equal(shuffled.statusCode, 200);
      assert.equal(shuffled.json().shuffled, true);
      assert.deepEqual(new Set(enqueuedIds), new Set(trackIds));

      enqueuedIds.length = 0;
      const lateLink = await app.inject({ method: "POST", url: "/api/sessions/guild-1/queue/external",
        payload: { url: "https://www.youtube.com/watch?v=fixture" } });
      assert.equal(lateLink.statusCode, 409);
      assert.deepEqual(enqueuedIds, [], "A late link must not start in the newly selected channel");
    } finally {
      if (app) await app.close();
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });
});
