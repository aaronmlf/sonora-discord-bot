import assert from "node:assert/strict";
import { it } from "node:test";
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { gzipSync, gunzipSync } from "node:zlib";
import { BackupService } from "../src/backup/backup-service.js";
import { LibraryService } from "../src/library/library-service.js";
import { PlaylistService } from "../src/playlists/playlist-service.js";
import { SceneService } from "../src/scenes/scene-service.js";
import { PlayerManager } from "../src/player/player-manager.js";
import type { AudioSourceFactory } from "../src/audio/audio-source-factory.js";
import type { LibraryTrack } from "../src/types.js";

async function bytes(stream: Readable): Promise<Buffer> { const chunks: Buffer[] = []; for await (const chunk of stream) chunks.push(Buffer.from(chunk)); return Buffer.concat(chunks); }
async function fixture(root: string) {
  const library = new LibraryService(path.join(root, "audio"), root); await library.initialize();
  const playlists = new PlaylistService(root); await playlists.initialize(); const scenes = new SceneService(root); await scenes.initialize();
  const players = new PlayerManager({ dataDir: root, audioSources: {} as AudioSourceFactory, defaultVolume: 70, defaultEffectVolume: 100, idleTimeoutMs: 0 });
  const service = new BackupService({ dataDir: root, audioDir: path.join(root, "audio"), maxBytes: 1024 * 1024, library, playlists, scenes, players });
  return { library, playlists, scenes, players, service };
}
it("exports native Windows legacy queue snapshots with portable catalog and backup paths", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "sonora-native-backup-"));
  const a = await fixture(root);
  try {
    const now = new Date().toISOString();
    const track: LibraryTrack = { id: "native", source: "local", title: "Tema", category: "music", relativePath: path.join("music", "Mesa", "tema.wav"), sizeBytes: 1, modifiedAt: now };
    await a.library.importCatalog({ tracks: [track], trash: [] });
    const player = a.players.getOrCreate("test-guild", "Teste");
    const queued = { ...track, requestedBy: "Teste", requestedAt: now };
    player.offerRecovery({ ...player.getSnapshot(), current: queued, upcoming: [{ ...queued, entryId: "next" }] });
    const archive = await bytes(await a.service.export(false));
    const records = gunzipSync(archive).toString("utf8").trim().split("\n").map(line => JSON.parse(line));
    const metadata = records[1].value;
    assert.equal(metadata.library.tracks[0].relativePath, "music/Mesa/tema.wav");
    assert.equal(metadata.sessions[0].current.relativePath, "music/Mesa/tema.wav");
    assert.equal(metadata.sessions[0].upcoming[0].relativePath, "music/Mesa/tema.wav");
    // Export must not mutate the in-memory recovery snapshot.
    assert.equal(player.recoverySnapshot()?.current?.source, "local");
    assert.deepEqual(player.recoverySnapshot()?.current, queued);
  } finally { a.players.shutdown(); await a.players.flush(); await rm(root, { recursive: true, force: true }); }
});
it("round-trips metadata and optional audio without exporting credentials", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "sonora-backup-test-"));
  const a = await fixture(path.join(root, "a")); const b = await fixture(path.join(root, "b"));
  try {
    await writeFile(path.join(root, "a", ".env"), "DISCORD_TOKEN=TEST_SECRET");
    await writeFile(path.join(root, "a", "access.json"), '{"sessionToken":"TEST_SECRET"}');
    const content = Buffer.from("audio content"); await writeFile(path.join(root, "a/audio/music/som.wav"), content);
    const now = new Date().toISOString();
    await a.library.importCatalog({ tracks: [{ id: "song", source: "local", title: "Chuva e trovão", category: "effect", relativePath: "music/som.wav", modifiedAt: now, sizeBytes: content.length, favorite: true, tags: ["combate"] }], trash: [] });
    const playlist = await a.playlists.create("Ação", undefined, ["song"]);
    await a.scenes.save({ name: "Taverna", playlistId: playlist.id, environments: [{ trackId: "song", volume: 25 }], effectIds: ["song"] });
    const metadata = await bytes(await a.service.export());
    assert.equal(gunzipSync(metadata).toString().includes("TEST_SECRET"), false);
    assert.equal(gunzipSync(metadata).toString().includes("access.json"), false);
    await b.service.restore(Readable.from([metadata])); assert.equal(b.library.get("song")?.title, "Chuva e trovão");
    await assert.rejects(readFile(path.join(root, "b/audio/music/som.wav")));
    const archive = await bytes(await a.service.export(true));
    const result = await b.service.restore(Readable.from([archive]));
    assert.equal(result.audioFiles, 1); assert.deepEqual(await readFile(path.join(root, "b/audio/music/som.wav")), content);
    assert.deepEqual(b.library.get("song")?.tags, ["combate"]); assert.equal(b.playlists.list()[0]?.items[0]?.trackId, "song"); assert.equal(b.scenes.list()[0]?.name, "Taverna");
    assert.ok((await readdir(path.join(root, "b/backups"))).includes(result.safetyBackup));
    const records = gunzipSync(archive).toString("utf8").trim().split("\n").map(line => JSON.parse(line));
    records[1].value.library.tracks[0].relativePath = "../.env";
    await assert.rejects(b.service.restore(Readable.from([gzipSync(records.map(record => JSON.stringify(record)).join("\n") + "\n")])));
    assert.equal(b.library.get("song")?.relativePath, "music/som.wav");
    await assert.rejects(b.service.restore(Readable.from([archive.subarray(0, archive.length - 15)])));
    assert.deepEqual(await readFile(path.join(root, "b/audio/music/som.wav")), content);
    const duplicateRecords = gunzipSync(metadata).toString("utf8").trim().split("\n").map(line => JSON.parse(line));
    const originalTrack = duplicateRecords[1].value.library.tracks[0];
    duplicateRecords[1].value.library.tracks.push({ ...originalTrack, id: "same-file-other-id" });
    await assert.rejects(b.service.restore(Readable.from([gzipSync(duplicateRecords.map(record => JSON.stringify(record)).join("\n") + "\n")])), /Arquivos duplicados/);
    assert.equal(b.library.list().length, 1);
    assert.deepEqual(await readFile(path.join(root, "b/audio/music/som.wav")), content);
  } finally { a.players.shutdown(); b.players.shutdown(); await a.players.flush(); await b.players.flush(); await rm(root, { recursive: true, force: true }); }
});
