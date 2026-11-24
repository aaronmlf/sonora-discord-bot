import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { it } from "node:test";
import { promisify } from "node:util";
import { createAudioResource, StreamType } from "@discordjs/voice";
import { AudioSourceFactory } from "../src/audio/audio-source-factory.js";
import { PCM_FRAME_BYTES, type DecodedAudio } from "../src/audio/pcm-mixer.js";
import { SessionMixer } from "../src/audio/session-mixer.js";
import { LibraryService } from "../src/library/library-service.js";
import type { ExternalSourceService } from "../src/sources/external-source-service.js";
import type { ExternalTrack, LibraryTrack } from "../src/types.js";

const exec = promisify(execFile);
const local: LibraryTrack = { id: "test", title: "Teste", source: "local", category: "music", relativePath: "music/test.wav", sizeBytes: 0, modifiedAt: new Date(0).toISOString() };
const external: ExternalTrack = { id: "youtube:test", title: "Teste externo", source: "youtube", category: "music", webpageUrl: "https://www.youtube.com/watch?v=test", originalUrl: "https://www.youtube.com/watch?v=test", resolvedFrom: "youtube" };

function wav(frames: number): Buffer {
  const size = PCM_FRAME_BYTES * frames;
  const data = Buffer.alloc(44 + size);
  data.write("RIFF"); data.writeUInt32LE(36 + size, 4); data.write("WAVEfmt ", 8);
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(2, 22);
  data.writeUInt32LE(48_000, 24); data.writeUInt32LE(192_000, 28); data.writeUInt16LE(4, 32); data.writeUInt16LE(16, 34);
  data.write("data", 36); data.writeUInt32LE(size, 40);
  for (let i = 44; i < data.length; i += 2) data.writeInt16LE(1000, i);
  return data;
}
function factory(file: string, command?: { command: string; args: string[] }, timeouts?: { startupMs: number; stalledMs: number }): AudioSourceFactory {
  return new AudioSourceFactory(
    { get: () => local, resolvePath: () => file } as unknown as LibraryService,
    { streamCommand: () => command } as unknown as ExternalSourceService,
    timeouts,
  );
}
async function collect(decoded: DecodedAudio): Promise<Buffer> {
  const parts: Buffer[] = [];
  try { for await (const part of decoded.stream) parts.push(part as Buffer); }
  finally { decoded.dispose(); }
  return Buffer.concat(parts);
}

it("plays a queued local snapshot from its current catalog path after moving the file", { timeout: 10_000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "sonora-path-playback-"));
  try {
    const library = new LibraryService(path.join(root, "audio"), root);
    await library.initialize(false);
    const oldPath = path.join(root, "audio/music/old.wav");
    await writeFile(oldPath, wav(10));
    const [queued] = await library.scan();
    assert.ok(queued);
    await mkdir(path.join(root, "audio/music/Pasta nova"));
    await rename(oldPath, path.join(root, "audio/music/Pasta nova/renomeada.wav"));
    const [moved] = await library.scan();
    assert.equal(moved?.id, queued.id);
    const sources = new AudioSourceFactory(library, {} as ExternalSourceService);
    assert.equal((await collect(sources.create(queued))).length, PCM_FRAME_BYTES * 10);
    await library.delete(queued.id);
    assert.throws(() => sources.create(queued), /não está mais na biblioteca/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("decodes local MP3, FLAC, Ogg, M4A and WebM through real FFmpeg", { timeout: 20_000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "sonora-formats-"));
  try {
    const original = path.join(root, "source.wav");
    await writeFile(original, wav(25));
    for (const extension of ["mp3", "flac", "ogg", "m4a", "webm"]) {
      const file = path.join(root, `audio.${extension}`);
      await exec("ffmpeg", ["-v", "error", "-i", original, file], { timeout: 10_000 });
      const output = await collect(factory(file).create(local));
      assert.ok(output.length >= PCM_FRAME_BYTES * 20, `${extension} must produce the complete audio, allowing codec padding`);
      assert.equal(output.length % 4, 0, `${extension} must produce stereo s16 PCM`);
      assert.ok(output.some(byte => byte !== 0), `${extension} must not be silent`);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("keeps real FFmpeg music and an effect continuous through the real Opus encoder", { timeout: 15_000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "sonora-opus-clock-"));
  const mixer = new SessionMixer();
  try {
    const file = path.join(root, "constant.wav");
    await writeFile(file, wav(250));
    const sources = factory(file);
    mixer.setMusicVolume(100);
    mixer.setMusic(local, sources.create(local));
    let hasAudio = false;
    let gaps = 0;
    let mixHeard = false;
    mixer.on("data", (chunk: Buffer) => {
      for (let offset = 0; offset < chunk.length; offset += PCM_FRAME_BYTES) {
        const sample = chunk.readInt16LE(offset);
        if (sample) hasAudio = true;
        else if (hasAudio) gaps++;
        if (sample === 2000) mixHeard = true;
      }
    });
    const resource = createAudioResource(mixer, { inputType: StreamType.Raw });
    try {
      await delay(250);
      const start = performance.now();
      let missing = 0;
      for (let index = 0; index < 150; index++) {
        await delay(Math.max(0, start + index * 20 - performance.now()));
        if (index === 40) mixer.addEffect(local, sources.create(local));
        if (!resource.read()) missing++;
      }
      assert.ok(hasAudio, "The real decoder must start");
      assert.ok(mixHeard, "The real effect must mix with music");
      assert.equal(gaps, 0, "The PCM mix must remain continuous after startup");
      assert.equal(missing, 0, "The Opus stream must supply every 20 ms voice packet");
    } finally { resource.playStream.destroy(); }
  } finally { mixer.destroy(); await rm(root, { recursive: true, force: true }); }
});

it("decodes a piped downloader and surfaces process errors instead of ending silently", { timeout: 10_000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "sonora-downloader-"));
  try {
    const file = path.join(root, "source.wav");
    await writeFile(file, wav(25));
    const command = { command: process.execPath, args: ["-e", "const fs = require('node:fs'); fs.writeSync(1, fs.readFileSync(process.argv[1]))", file] };
    assert.equal((await collect(factory(file, command).create(external))).length, PCM_FRAME_BYTES * 25);
    await assert.rejects(collect(factory(file, { command: process.execPath, args: ["-e", "require('node:fs').writeSync(2, 'synthetic failure'); process.exit(23)"] }).create(external)), /yt-dlp.*23.*synthetic failure/);
    await assert.rejects(collect(factory(path.join(root, "missing.wav")).create(local)), /FFmpeg/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("fails a downloader that never sends audio, and does not time out intentionally paused audio", { timeout: 10_000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "sonora-decoder-timeout-"));
  try {
    const file = path.join(root, "source.wav");
    await writeFile(file, wav(100));
    const stalled = factory(file, { command: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"] }, { startupMs: 150, stalledMs: 150 });
    await assert.rejects(collect(stalled.create(external)), /demorou demais para iniciar/);
    const partial = wav(1_000);
    await writeFile(file, partial);
    const stopsSending = factory(file, {
      command: process.execPath,
      args: ["-e", "const fs = require('node:fs'); fs.writeSync(1, fs.readFileSync(process.argv[1]).subarray(0, 1536044)); setInterval(() => {}, 1000)", file],
    }, { startupMs: 2_000, stalledMs: 150 });
    let bytesBeforeStall = 0;
    const interrupted = stopsSending.create(external);
    interrupted.stream.on("data", (chunk: Buffer) => { bytesBeforeStall += chunk.length; });
    await assert.rejects(collect(interrupted), /parou de enviar dados/);
    assert.ok(bytesBeforeStall > 0, "The stalled-source deadline is measured after real PCM arrives");
    await writeFile(file, wav(100));
    const decoded = factory(file, undefined, { startupMs: 1_000, stalledMs: 100 }).create(local);
    let error: Error | undefined;
    decoded.stream.on("error", reason => { error = reason; });
    try {
      // No consumer: buffering must stop FFmpeg, not trigger its watchdog.
      await delay(500);
      assert.equal(error, undefined);
      assert.equal((await collect(decoded)).length, PCM_FRAME_BYTES * 100);
    } finally { decoded.dispose(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});
