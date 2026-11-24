import assert from "node:assert/strict";
import { it } from "node:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { PlayerManager } from "../src/player/player-manager.js";
import type { AudioSourceFactory } from "../src/audio/audio-source-factory.js";
import type { QueuedTrack } from "../src/types.js";

const track = (id: string): Extract<QueuedTrack, { source: "local" }> => ({ id, source: "local", title: id, category: "music", relativePath: `music/${id}.wav`, modifiedAt: new Date(0).toISOString(), sizeBytes: 1, requestedAt: new Date(0).toISOString(), requestedBy: "test" });
const audioSources = { create: () => { const stream = new PassThrough(); return { stream, dispose: () => stream.destroy() }; } } as unknown as AudioSourceFactory;

it("persists queue and settings, offers explicit restoration without joining voice", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "sonora-recovery-"));
  const options = { dataDir: root, audioSources, defaultVolume: 70, defaultEffectVolume: 100, idleTimeoutMs: 0 };
  const managers: PlayerManager[] = [];
  try {
    const first = new PlayerManager(options); managers.push(first); await first.initialize();
    const player = first.getOrCreate("guild", "Mesa"); player.enqueueMany([track("a"), track("b"), track("b")]);
    player.setVolume(31); player.setEffectVolume(82); player.setEnvironmentVolume(44); player.setRepeatMode("queue");
    const ids = player.getSnapshot().upcoming.map(t => t.entryId);
    assert.notEqual(ids[0], ids[1]);
    assert.ok(player.entryAction(ids[0]!, "remove"));
    assert.equal(player.entryAction(ids[0]!, "play"), false, "Stale identity must not select the next item");
    await first.checkpoint(); first.shutdown(); await first.flush();
    const persisted = JSON.parse(await readFile(path.join(root, "sessions.json"), "utf8"));
    assert.equal(persisted.sessions[0].current.id, "a");
    const second = new PlayerManager(options); managers.push(second); await second.initialize();
    const recovered = second.get("guild")!; const state = recovered.getSnapshot();
    assert.equal(state.voiceChannelId, undefined); assert.equal(state.current, null); assert.equal(state.recoveryAvailable, true);
    assert.equal(state.volume, 31); assert.equal(state.repeatMode, "queue"); assert.equal(state.environmentVolume, 44);
    recovered.restoreRecovery(t => t);
    assert.equal(recovered.getSnapshot().current?.id, "a"); assert.equal(recovered.getSnapshot().upcoming.length, 1);
    assert.equal(recovered.getSnapshot().recoveryAvailable, false);
    recovered.playEffect({ ...track("effect"), category: "effect" }); recovered.pause();
    assert.equal(recovered.getSnapshot().status, "paused"); assert.equal(recovered.getSnapshot().activeEffects.length, 1);
    recovered.skip(); assert.equal(recovered.getSnapshot().activeEffects.length, 1);
  } finally {
    for (const manager of managers) { manager.shutdown(); await manager.flush(); }
    await rm(root, { recursive: true, force: true });
  }
});

it("exports current settings while preserving the queue offered for recovery", () => {
  const manager = new PlayerManager({ audioSources, defaultVolume: 70, defaultEffectVolume: 100, idleTimeoutMs: 0 });
  try {
    const player = manager.getOrCreate("guild", "Mesa");
    player.offerRecovery({ ...player.getSnapshot(), current: track("saved"), upcoming: [track("next")], volume: 15, effectVolume: 20, environmentVolume: 25, repeatMode: "off", ducking: false });
    player.setVolume(80); player.setEffectVolume(90); player.setEnvironmentVolume(60); player.setRepeatMode("queue"); player.setDucking(true);
    const [exported] = manager.exportSessions();
    assert.equal(exported?.current?.id, "saved"); assert.equal(exported?.upcoming[0]?.id, "next");
    assert.equal(exported?.volume, 80); assert.equal(exported?.effectVolume, 90); assert.equal(exported?.environmentVolume, 60);
    assert.equal(exported?.repeatMode, "queue"); assert.equal(exported?.ducking, true);
    assert.equal(player.getSnapshot().current, null, "Export must not begin playback");
  } finally { manager.shutdown(); }
});
