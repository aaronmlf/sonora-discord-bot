import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, it } from "node:test";

import { AccessService } from "../src/access/access-service.js";
import { TrackQueue } from "../src/core/queue.js";
import type { DiscordBot } from "../src/discord/discord-bot.js";
import { LibraryService } from "../src/library/library-service.js";
import type { PlayerManager } from "../src/player/player-manager.js";
import { PlaylistService } from "../src/playlists/playlist-service.js";
import { createAppServer, type AppServer } from "../src/server/app-server.js";
import type { ExternalSourceService } from "../src/sources/external-source-service.js";
import type { LibraryTrack } from "../src/types.js";

function silentWav(): Buffer {
  const result = Buffer.alloc(1644);
  result.write("RIFF", 0); result.writeUInt32LE(1636, 4); result.write("WAVEfmt ", 8);
  result.writeUInt32LE(16, 16); result.writeUInt16LE(1, 20); result.writeUInt16LE(1, 22);
  result.writeUInt32LE(8000, 24); result.writeUInt32LE(16000, 28);
  result.writeUInt16LE(2, 32); result.writeUInt16LE(16, 34);
  result.write("data", 36); result.writeUInt32LE(1600, 40);
  return result;
}

describe("Library scan reconciliation", () => {
  for (const trigger of ["api", "startup"] as const) {
    it(`${trigger}: atualiza os caminhos da fila e avisa painéis já abertos`, async () => {
      const root = await mkdtemp(path.join(tmpdir(), "sonora-reconcile-"));
      let app: AppServer | undefined;
      try {
        const audioDir = path.join(root, "audio"); const dataDir = path.join(root, "data");
        await mkdir(path.join(audioDir, "music"), { recursive: true });
        const oldPath = path.join(audioDir, "music", "tema.wav");
        await writeFile(oldPath, silentWav());
        const library = new LibraryService(audioDir, dataDir); await library.initialize();
        const track = library.list()[0]!;
        const queue = new TrackQueue();
        const requested = { ...track, requestedBy: "Teste", requestedAt: new Date().toISOString() };
        queue.enqueue(requested); queue.beginNext(); queue.enqueue(requested);
        const originalEntryId = queue.upcoming[0]!.entryId;
        const updates: LibraryTrack[] = [];
        const players = Object.assign(new EventEmitter(), {
          list: () => [],
          updateTrack: (updated: LibraryTrack) => { updates.push(updated); queue.replaceLibraryTrack(updated); },
          removeTrack: (id: string) => queue.removeByTrackId(id),
        }) as unknown as PlayerManager;
        const playlists = new PlaylistService(dataDir); await playlists.initialize();
        const playlist = await playlists.create("Mesa", undefined, [track.id]);
        const access = new AccessService(dataDir); await access.initialize();
        const bot = Object.assign(new EventEmitter(), {
          getStatus: () => ({ configured: false, connected: false, username: null }),
        }) as unknown as DiscordBot;
        app = await createAppServer({
          config: { host: "127.0.0.1", port: 3210, remoteAccessEnabled: false, audioDir, dataDir,
            ytDlpPath: "yt-dlp", defaultVolume: 70, defaultEffectVolume: 100, idleTimeoutMs: 0,
            maxUploadBytes: 10 * 1024 * 1024, logLevel: "silent" },
          library, playlists, access, players, bot, externalSources: {} as ExternalSourceService,
        });
        const stream = app.inject({ url: "/api/events" });
        await delay(20);
        await mkdir(path.join(audioDir, "music", "Campanha"));
        await rename(oldPath, path.join(audioDir, "music", "Campanha", "tema.wav"));
        if (trigger === "api") {
          const response = await app.inject({ method: "POST", url: "/api/library/scan" });
          assert.equal(response.statusCode, 200, response.body);
        } else {
          await app.scanLibrary();
        }
        assert.equal(updates.length, 1);
        const newPath = path.join("music", "Campanha", "tema.wav");
        assert.equal(queue.current?.source, "local");
        assert.equal((queue.current as LibraryTrack).relativePath, newPath);
        assert.equal((queue.upcoming[0] as LibraryTrack).relativePath, newPath);
        assert.equal(queue.upcoming[0]!.entryId, originalEntryId);
        assert.equal(playlists.get(playlist.id)?.items[0]?.trackId, track.id);
        await app.scanLibrary();
        assert.equal(updates.length, 1, "An unchanged scan must not rewrite every active queue");
        await app.close();
        const events = (await stream).body;
        assert.match(events, /event: library\n/);
        assert.match(events, /event: studio\n/);
        const libraryEvents = events.split("\n\n").filter(event => event.startsWith("event: library\n"));
        assert.ok(libraryEvents.some(event => JSON.parse(event.split("\ndata: ")[1]!)[0].relativePath === newPath));
      } finally {
        await app?.close();
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});
