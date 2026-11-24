import assert from "node:assert/strict";
import { it } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AudioSourceFactory } from "../src/audio/audio-source-factory.js";
import { PCM_FRAME_BYTES } from "../src/audio/pcm-mixer.js";
import type { LibraryService } from "../src/library/library-service.js";
import type { ExternalSourceService } from "../src/sources/external-source-service.js";
import type { LibraryTrack } from "../src/types.js";

it("FFmpeg loops a local environment beyond the original file duration", { timeout: 10000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "sonora-loop-"));
  const file = path.join(root, "loop.wav");
  const payloadSize = PCM_FRAME_BYTES * 5; // 100 ms of stereo PCM.
  const wav = Buffer.alloc(44 + payloadSize);
  wav.write("RIFF", 0); wav.writeUInt32LE(36 + payloadSize, 4); wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(2, 22);
  wav.writeUInt32LE(48000, 24); wav.writeUInt32LE(192000, 28); wav.writeUInt16LE(4, 32); wav.writeUInt16LE(16, 34);
  wav.write("data", 36); wav.writeUInt32LE(payloadSize, 40);
  for (let i = 44; i < wav.length; i += 2) wav.writeInt16LE(1000, i);
  await writeFile(file, wav);
  const track: LibraryTrack = { id: "loop", title: "Loop", source: "local", category: "music", relativePath: "music/loop.wav", sizeBytes: wav.length, modifiedAt: new Date().toISOString() };
  const factory = new AudioSourceFactory({ get: () => track, resolvePath: () => file } as unknown as LibraryService, {} as ExternalSourceService);
  const decoded = factory.create(track, true);
  const timeout = setTimeout(() => decoded.stream.destroy(new Error("FFmpeg loop timed out")), 5000);
  try {
    let bytes = 0;
    for await (const chunk of decoded.stream) {
      const buffer = chunk as Buffer;
      assert.equal(buffer.readInt16LE(0), 1000);
      bytes += buffer.length;
      if (bytes >= payloadSize * 4) break;
    }
    assert.ok(bytes >= payloadSize * 4, "The environment must play beyond its original duration");
  } finally { clearTimeout(timeout); decoded.dispose(); await rm(root, { recursive: true, force: true }); }
});
