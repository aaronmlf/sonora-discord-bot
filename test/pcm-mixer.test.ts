import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Readable } from "node:stream";

import {
  PCM_FRAME_BYTES,
  PcmMixer,
  mixPcmFrames,
  type DecodedAudio,
} from "../src/audio/pcm-mixer.js";
import type { QueuedTrack } from "../src/types.js";

function frame(sample: number): Buffer {
  const result = Buffer.alloc(PCM_FRAME_BYTES);
  for (let offset = 0; offset < result.length; offset += 2) {
    result.writeInt16LE(sample, offset);
  }
  return result;
}

function decoded(frames: Buffer[], onDispose = () => {}): DecodedAudio {
  return { stream: Readable.from(frames), dispose: onDispose };
}

function effectTrack(): QueuedTrack {
  return {
    id: "effect",
    source: "local",
    title: "Tiro",
    category: "effect",
    relativePath: "effects/tiro.wav",
    sizeBytes: 1,
    modifiedAt: new Date(0).toISOString(),
    requestedBy: "teste",
    requestedAt: new Date(0).toISOString(),
  };
}

describe("mixPcmFrames", () => {
  it("soma musica e efeito sem interromper a musica", () => {
    const mixed = mixPcmFrames(frame(1_000), [frame(2_000)], 100, 100);
    assert.equal(mixed.readInt16LE(0), 3_000);
    assert.equal(mixed.readInt16LE(PCM_FRAME_BYTES - 2), 3_000);
  });

  it("aplica volumes independentes e limita clipping", () => {
    const controlled = mixPcmFrames(frame(10_000), [frame(10_000)], 50, 25);
    assert.equal(controlled.readInt16LE(0), 7_500);
    const clipped = mixPcmFrames(frame(30_000), [frame(30_000)], 100, 100);
    assert.equal(clipped.readInt16LE(0), 32_767);
  });
});

describe("PcmMixer", () => {
  it("mantem a faixa principal depois que o efeito termina", async () => {
    const mixer = new PcmMixer(decoded([frame(1_000), frame(1_000)]), {
      musicVolume: 100,
      effectVolume: 100,
    });
    mixer.addEffect(effectTrack(), decoded([frame(2_000)]));

    const chunks: Buffer[] = [];
    for await (const chunk of mixer) chunks.push(Buffer.from(chunk as Buffer));
    const output = Buffer.concat(chunks);

    assert.equal(output.length, PCM_FRAME_BYTES * 2);
    assert.equal(output.readInt16LE(0), 3_000);
    assert.equal(output.readInt16LE(PCM_FRAME_BYTES), 1_000);
    assert.deepEqual(mixer.activeEffects(), []);
  });
});
