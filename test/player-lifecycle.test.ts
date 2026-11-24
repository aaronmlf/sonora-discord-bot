import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { it } from "node:test";
import { AudioPlayerStatus, VoiceConnectionStatus, type AudioPlayer, type AudioResource, type VoiceConnection } from "@discordjs/voice";
import { GuildPlayer } from "../src/player/guild-player.js";
import type { AudioSourceFactory } from "../src/audio/audio-source-factory.js";
import type { SessionMixer } from "../src/audio/session-mixer.js";
import type { LibraryTrack, QueuedTrack, Scene } from "../src/types.js";
import { PCM_FRAME_BYTES } from "../src/audio/pcm-mixer.js";

const track = (id: string): QueuedTrack => ({ id, title: id, source: "local", category: "music", relativePath: `music/${id}.wav`, sizeBytes: 1, modifiedAt: "", requestedAt: "", requestedBy: "test" });
function fixture() {
  const decoders: PassThrough[] = [];
  const audioSources = { create: () => { const stream = new PassThrough(); decoders.push(stream); return { stream, dispose: () => stream.destroy() }; } } as unknown as AudioSourceFactory;
  const player = new GuildPlayer({ guildId: "test", guildName: "Test", defaultVolume: 70, defaultEffectVolume: 100, idleTimeoutMs: 0, audioSources });
  const internals = player as unknown as { player: AudioPlayer; resource: AudioResource | null; mixer: SessionMixer | null };
  return { player, internals, decoders };
}
class Connection extends EventEmitter {
  state = { status: VoiceConnectionStatus.Ready };
  subscribe() { return {}; }
  change(status: VoiceConnectionStatus) {
    const old = this.state; this.state = { status };
    this.emit("stateChange", old, this.state); this.emit(status, old, this.state);
  }
  destroy() { this.change(VoiceConnectionStatus.Destroyed); }
  asVoice() { return this as unknown as VoiceConnection; }
}

it("recovers from an unexpectedly closed encoder instead of sticking on playing", async () => {
  const { player, internals, decoders } = fixture();
  const errors: string[] = [];
  player.on("update", state => { if (state.error) errors.push(state.error); });
  try {
    player.enqueueMany([track("broken"), track("next")]);
    const oldMixer = internals.mixer;
    internals.resource!.playStream.destroy();
    await delay(50);
    assert.equal(player.getSnapshot().current?.id, "next");
    assert.notEqual(internals.mixer, oldMixer);
    assert.equal(oldMixer?.destroyed, true);
    assert.equal(decoders[0]?.destroyed, true);
    assert.notEqual(internals.player.state.status, AudioPlayerStatus.Idle);
    assert.ok(errors.some(error => error.includes("interrompido")));
  } finally { player.leave(); }
});

it("does not loop a failed resource or leave it marked as playing", async () => {
  const { player, internals } = fixture();
  try {
    player.setRepeatMode("track"); player.enqueue(track("broken"));
    internals.resource!.playStream.destroy();
    await delay(40);
    assert.equal(player.getSnapshot().current, null);
    assert.equal(player.getSnapshot().status, "error");
    assert.equal(internals.mixer, null);
    player.enqueue(track("new"));
    assert.equal(player.getSnapshot().current?.id, "new");
    assert.ok(internals.resource);
  } finally { player.leave(); }
});

it("preserves the current track on voice loss and resumes after /join", () => {
  const { player } = fixture(); const first = new Connection(); const next = new Connection();
  try {
    player.attachConnection(first.asVoice(), { id: "channel", name: "Mesa" });
    player.enqueueMany([track("current"), track("next")]);
    first.change(VoiceConnectionStatus.Disconnected);
    assert.equal(player.getSnapshot().status, "paused");
    first.destroy();
    assert.equal(player.getSnapshot().voiceChannelId, undefined);
    assert.equal(player.getSnapshot().current?.id, "current");
    assert.equal(player.getSnapshot().upcoming.length, 1);
    assert.match(player.getSnapshot().error!, /join/);
    assert.equal(player.resume(), false, "Do not pretend voice has resumed while disconnected");
    player.attachConnection(next.asVoice(), { id: "channel", name: "Mesa" });
    assert.equal(player.getSnapshot().status, "buffering", "No PCM has arrived yet");
    assert.equal(player.getSnapshot().error, null);
    assert.equal(first.listenerCount("stateChange"), 0);
  } finally { player.leave(); }
  assert.equal(player.getSnapshot().status, "idle");
  assert.equal(player.getSnapshot().error, null);
});

it("keeps a user-paused song paused across reconnection and handles voice errors", () => {
  const { player } = fixture(); const connection = new Connection();
  try {
    player.attachConnection(connection.asVoice(), { id: "channel", name: "Mesa" });
    player.enqueue(track("current")); player.pause();
    connection.emit("error", new Error("voice packet failure"));
    assert.match(player.getSnapshot().error!, /voice packet failure/);
    connection.change(VoiceConnectionStatus.Disconnected);
    connection.change(VoiceConnectionStatus.Ready);
    assert.equal(player.getSnapshot().status, "paused");
    assert.equal(player.resume(), true);
  } finally { player.leave(); }
});

it("shows loading until real PCM arrives and freezes the timeline during buffering", () => {
  const { player, internals, decoders } = fixture();
  try {
    player.enqueue(track("slow"));
    assert.equal(player.getSnapshot().status, "buffering");
    assert.equal(player.getSnapshot().startedAt, null);
    decoders[0]!.write(Buffer.alloc(PCM_FRAME_BYTES, 1));
    internals.mixer!.renderFrame();
    assert.equal(player.getSnapshot().status, "playing");
    assert.ok(player.getSnapshot().startedAt);
    internals.mixer!.renderFrame();
    assert.equal(player.getSnapshot().status, "buffering");
    assert.ok(player.getSnapshot().pausedAt);
    player.pause();
    assert.equal(player.getSnapshot().status, "paused");
    player.resume();
    assert.equal(player.getSnapshot().status, "buffering");
  } finally { player.leave(); }
});

it("does not leave an effects-only session marked paused after voice recovery", () => {
  const { player } = fixture(); const connection = new Connection();
  try {
    player.attachConnection(connection.asVoice(), { id: "channel", name: "Mesa" });
    player.playEffect(track("effect"));
    connection.change(VoiceConnectionStatus.Disconnected);
    connection.change(VoiceConnectionStatus.Ready);
    assert.equal(player.getSnapshot().status, "idle");
    assert.equal(player.getSnapshot().activeEffects.length, 1);
  } finally { player.leave(); }
});

it("does not start an empty mixer when an effect, environment or scene cannot be opened", async () => {
  for (const kind of ["effect", "environment", "scene"] as const) {
    const audioSources = { create: () => { throw new Error("Arquivo indisponível"); } } as unknown as AudioSourceFactory;
    const player = new GuildPlayer({ guildId: "test", guildName: "Test", defaultVolume: 70, defaultEffectVolume: 100, idleTimeoutMs: 20, audioSources });
    const connection = new Connection();
    const failedTrack = track("missing");
    const scene: Scene = { id: "scene", name: "Scene", playlistId: null, environments: [], effectIds: [], musicVolume: 70, effectVolume: 100, environmentVolume: 70, ducking: false, transitionMs: 0 };
    try {
      player.attachConnection(connection.asVoice(), { id: "channel", name: "Mesa" });
      assert.throws(() => {
        if (kind === "effect") player.playEffect(failedTrack);
        else if (kind === "environment") player.addEnvironment(failedTrack as LibraryTrack, 100);
        else player.activateScene(scene, [failedTrack], []);
      }, /Arquivo indisponível/);
      assert.equal((player as unknown as { mixer: SessionMixer | null }).mixer, null, `${kind} must not leak a silent mixer`);
      await delay(50);
      assert.equal(connection.state.status, VoiceConnectionStatus.Destroyed, `${kind} must preserve the idle disconnect timer`);
    } finally { player.leave(); }
  }
});
