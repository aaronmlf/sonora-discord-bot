import assert from "node:assert/strict";
import { it } from "node:test";
import { Readable, PassThrough } from "node:stream";
import { setImmediate as tick } from "node:timers/promises";
import { setTimeout as delay } from "node:timers/promises";
import { performance } from "node:perf_hooks";
import { SessionMixer } from "../src/audio/session-mixer.js";
import { PCM_FRAME_BYTES, type DecodedAudio } from "../src/audio/pcm-mixer.js";
import type { LibraryTrack } from "../src/types.js";

const track: LibraryTrack = { id: "local", source: "local", title: "Teste", category: "music", relativePath: "music/test.wav", modifiedAt: new Date(0).toISOString(), sizeBytes: 1 };

it("reports buffering until actual music arrives and on a stall, but not while paused", async () => {
  const mixer = new SessionMixer();
  const stream = new PassThrough();
  const states: string[] = [];
  mixer.on("musicState", state => states.push(state));
  try {
    mixer.setMusic(track, { stream, dispose: () => stream.destroy() });
    mixer.renderFrame(); mixer.renderFrame();
    assert.deepEqual(states, ["buffering"]);
    stream.write(frame(1000)); await tick(); mixer.renderFrame();
    assert.deepEqual(states, ["buffering", "playing"]);
    mixer.pauseMusic(true); mixer.renderFrame();
    assert.deepEqual(states, ["buffering", "playing"]);
    mixer.pauseMusic(false); mixer.renderFrame(); mixer.renderFrame();
    assert.deepEqual(states, ["buffering", "playing", "buffering"]);
    stream.end(frame(1000)); await tick(); mixer.renderFrame();
    assert.deepEqual(states, ["buffering", "playing", "buffering", "playing"]);
    mixer.setMusic(track, source(1000));
    assert.equal(states.at(-1), "buffering", "The next track has its own readiness");
  } finally { mixer.destroy(); }
});

it("keeps continuous music and effects on the voice clock despite render cost", async () => {
  const mixer = new SessionMixer();
  try {
    mixer.setMusicVolume(100);
    mixer.setMusic(track, source(1000, 300));
    mixer.addEffect(track, source(2000, 300));
    await tick();
    const render = mixer.renderFrame.bind(mixer);
    mixer.renderFrame = () => {
      const until = performance.now() + 3;
      while (performance.now() < until) { /* Simulate encoder/mixing work. */ }
      return render();
    };
    mixer.read(0);
    await delay(40);
    const start = performance.now();
    let missing = 0;
    for (let i = 0; i < 150; i++) {
      await delay(Math.max(0, start + i * 20 - performance.now()));
      const packet = mixer.read(PCM_FRAME_BYTES) as Buffer | null;
      if (!packet) missing++;
      else assert.equal(packet.readInt16LE(0), 3000);
    }
    assert.equal(missing, 0, "The mixer must not accumulate timing drift");
  } finally { mixer.destroy(); }
});

it("bounds queued audio when consumption stops and resumes without a backlog", async () => {
  const mixer = new SessionMixer();
  try {
    mixer.setMusic(track, source(1000));
    await tick();
    mixer.read(0);
    await delay(160);
    assert.equal(mixer.readableLength, PCM_FRAME_BYTES * 4);
    await delay(100);
    assert.equal(mixer.readableLength, PCM_FRAME_BYTES * 4);
    assert.ok(mixer.read(PCM_FRAME_BYTES * 4));
    await delay(30);
    assert.ok(mixer.readableLength >= PCM_FRAME_BYTES * 2);
    assert.ok(mixer.readableLength <= PCM_FRAME_BYTES * 4);
  } finally { mixer.destroy(); }
});
function frame(sample: number): Buffer { const buffer = Buffer.alloc(PCM_FRAME_BYTES); for (let i = 0; i < buffer.length; i += 2) buffer.writeInt16LE(sample, i); return buffer; }
function source(sample: number, count = 200): DecodedAudio {
  const stream = Readable.from(Array.from({ length: count }, () => frame(sample)), { objectMode: false });
  return { stream, dispose: () => stream.destroy() };
}

it("mixes music, rain and effects independently, including while music is paused", async () => {
  const mixer = new SessionMixer();
  try {
    mixer.setMusicVolume(100); mixer.setEnvironmentVolume(100); mixer.setEffectVolume(100);
    mixer.setMusic(track, source(1000)); mixer.addEnvironment(track, source(2000), 50); mixer.addEffect(track, source(3000));
    await tick();
    assert.equal(mixer.renderFrame().readInt16LE(0), 5000);
    mixer.pauseMusic(true);
    assert.equal(mixer.renderFrame().readInt16LE(0), 4000);
    mixer.setEffectVolume(50); assert.equal(mixer.renderFrame().readInt16LE(0), 2500);
    mixer.stopEffects(); assert.equal(mixer.renderFrame().readInt16LE(0), 1000);
    mixer.pauseMusic(false); assert.equal(mixer.renderFrame().readInt16LE(0), 2000);
  } finally { mixer.destroy(); }
});

it("plays effects without music and isolates decoder errors and slow effects", async () => {
  const mixer = new SessionMixer();
  try {
    const broken = new PassThrough(); let reported = 0;
    mixer.on("sourceError", () => reported++);
    mixer.addEffect(track, { stream: broken, dispose: () => broken.destroy() });
    const slow = new PassThrough(); mixer.addEffect(track, { stream: slow, dispose: () => slow.destroy() });
    mixer.addEffect(track, source(3000)); broken.destroy(new Error("bad effect"));
    await tick();
    assert.equal(mixer.renderFrame().readInt16LE(0), 3000);
    assert.equal(reported, 1); assert.equal(mixer.destroyed, false);
    mixer.stopEffects(); assert.equal(mixer.activeEffects().length, 0);
  } finally { mixer.destroy(); }
});

it("crossfades scene music and environments over 2 seconds without replacing effects", async () => {
  const mixer = new SessionMixer();
  try {
    mixer.setMusicVolume(100); mixer.setEnvironmentVolume(100); mixer.setEffectVolume(100);
    mixer.setMusic(track, source(1000)); mixer.addEnvironment(track, source(1000), 100);
    const effect = mixer.addEffect(track, source(1000)); await tick();
    assert.equal(mixer.renderFrame().readInt16LE(0), 3000);
    mixer.setMusic(track, source(3000), 2000);
    mixer.replaceEnvironments([{ track, decoded: source(3000), volume: 100 }], 2000);
    await tick();
    assert.equal(mixer.renderFrame().readInt16LE(0), 3040);
    let sample = 0;
    for (let i = 1; i < 100; i++) { sample = mixer.renderFrame().readInt16LE(0); await tick(); }
    assert.equal(sample, 7000);
    assert.equal(mixer.activeEffects()[0]?.playbackId, effect.playbackId);
  } finally { mixer.destroy(); }
});

it("limits environments and effects and releases rejected decoders", () => {
  const mixer = new SessionMixer(); let disposed = 0;
  try {
    for (let i = 0; i < 8; i++) mixer.addEffect(track, source(1));
    assert.throws(() => mixer.addEffect(track, { stream: new PassThrough(), dispose: () => disposed++ }), /oito/);
    for (let i = 0; i < 3; i++) mixer.addEnvironment(track, source(1), 100);
    assert.throws(() => mixer.addEnvironment(track, { stream: new PassThrough(), dispose: () => disposed++ }, 100), /três/);
    assert.equal(disposed, 2);
  } finally { mixer.destroy(); }
});

it("ducking is opt-in, fades down and recovers after effects stop", async () => {
  const mixer = new SessionMixer();
  try {
    mixer.setMusicVolume(100); mixer.setMusic(track, source(10000)); mixer.addEffect(track, source(0)); await tick();
    assert.equal(mixer.renderFrame().readInt16LE(0), 10000);
    mixer.setDucking(true);
    for (let i = 0; i < 10; i++) { mixer.renderFrame(); await tick(); }
    assert.equal(mixer.renderFrame().readInt16LE(0), 3000);
    mixer.stopEffects();
    for (let i = 0; i < 10; i++) { mixer.renderFrame(); await tick(); }
    assert.equal(mixer.renderFrame().readInt16LE(0), 10000);
  } finally { mixer.destroy(); }
});
