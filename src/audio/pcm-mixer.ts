import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";

import type { ActiveEffect, QueuedTrack } from "../types.js";

export const PCM_SAMPLE_RATE = 48_000;
export const PCM_CHANNELS = 2;
export const PCM_FRAME_DURATION_MS = 20;
export const PCM_FRAME_BYTES =
  (PCM_SAMPLE_RATE * PCM_CHANNELS * 2 * PCM_FRAME_DURATION_MS) / 1_000;

export interface DecodedAudio {
  stream: Readable;
  dispose: () => void;
}

interface EffectInput {
  metadata: ActiveEffect;
  source: PcmInput;
}

class PcmInput {
  private readonly iterator: AsyncIterator<unknown>;
  private buffered: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private ended = false;

  constructor(private readonly decoded: DecodedAudio) {
    this.iterator = decoded.stream[Symbol.asyncIterator]();
  }

  async readFrame(): Promise<Buffer | null> {
    while (this.buffered.length < PCM_FRAME_BYTES && !this.ended) {
      const next = await this.iterator.next();
      if (next.done) {
        this.ended = true;
        this.decoded.dispose();
        break;
      }
      const chunk = Buffer.isBuffer(next.value)
        ? next.value
        : Buffer.from(next.value as Uint8Array);
      this.buffered = this.buffered.length
        ? Buffer.concat([this.buffered, chunk])
        : chunk;
    }

    if (this.buffered.length === 0 && this.ended) return null;
    const frame = Buffer.alloc(PCM_FRAME_BYTES);
    const bytes = Math.min(this.buffered.length, PCM_FRAME_BYTES);
    this.buffered.copy(frame, 0, 0, bytes);
    this.buffered = this.buffered.subarray(bytes);
    return frame;
  }

  dispose(): void {
    this.ended = true;
    this.buffered = Buffer.alloc(0);
    void this.iterator.return?.();
    this.decoded.dispose();
  }
}

export function mixPcmFrames(
  primary: Buffer | null,
  effects: readonly Buffer[],
  musicVolume: number,
  effectVolume: number,
): Buffer {
  const output = Buffer.alloc(PCM_FRAME_BYTES);
  const musicGain = Math.max(0, musicVolume) / 100;
  const effectGain = Math.max(0, effectVolume) / 100;

  for (let offset = 0; offset < PCM_FRAME_BYTES; offset += 2) {
    let sample = primary ? primary.readInt16LE(offset) * musicGain : 0;
    for (const effect of effects) sample += effect.readInt16LE(offset) * effectGain;
    output.writeInt16LE(Math.max(-32_768, Math.min(32_767, Math.round(sample))), offset);
  }
  return output;
}

export class PcmMixer extends Readable {
  private readonly primary: PcmInput;
  private readonly effects = new Map<string, EffectInput>();
  private primaryEnded = false;
  private pulling = false;
  private musicVolume: number;
  private effectVolume: number;

  constructor(
    primary: DecodedAudio,
    options: { musicVolume: number; effectVolume: number },
  ) {
    super({ highWaterMark: PCM_FRAME_BYTES * 4 });
    this.primary = new PcmInput(primary);
    this.musicVolume = options.musicVolume;
    this.effectVolume = options.effectVolume;
  }

  setMusicVolume(value: number): void {
    this.musicVolume = Math.max(0, Math.min(100, value));
  }

  setEffectVolume(value: number): void {
    this.effectVolume = Math.max(0, Math.min(150, value));
  }

  addEffect(track: QueuedTrack, decoded: DecodedAudio): ActiveEffect {
    if (this.destroyed) throw new Error("O mixer de audio ja foi encerrado.");
    if (this.effects.size >= 8) {
      decoded.dispose();
      throw new Error("Ja existem muitos efeitos tocando ao mesmo tempo.");
    }
    const metadata: ActiveEffect = {
      playbackId: randomUUID(),
      trackId: track.id,
      title: track.title,
      startedAt: new Date().toISOString(),
    };
    this.effects.set(metadata.playbackId, {
      metadata,
      source: new PcmInput(decoded),
    });
    this.emit("effectStart", metadata);
    return metadata;
  }

  activeEffects(): ActiveEffect[] {
    return [...this.effects.values()].map(({ metadata }) => ({ ...metadata }));
  }

  override _read(): void {
    if (this.pulling) return;
    this.pulling = true;
    void this.produceFrame();
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this.primary.dispose();
    for (const { source } of this.effects.values()) source.dispose();
    this.effects.clear();
    callback(error);
  }

  private async produceFrame(): Promise<void> {
    let continuePulling = false;
    try {
      const primaryPromise = this.primaryEnded
        ? Promise.resolve(null)
        : this.primary.readFrame();
      const effectEntries = [...this.effects.entries()];
      const [primaryFrame, effectFrames] = await Promise.all([
        primaryPromise,
        Promise.all(effectEntries.map(([, effect]) => effect.source.readFrame())),
      ]);

      if (primaryFrame === null) this.primaryEnded = true;
      const liveEffectFrames: Buffer[] = [];
      for (let index = 0; index < effectEntries.length; index += 1) {
        const [playbackId, effect] = effectEntries[index] as [string, EffectInput];
        const frame = effectFrames[index];
        if (frame) {
          liveEffectFrames.push(frame);
        } else {
          this.effects.delete(playbackId);
          effect.source.dispose();
          this.emit("effectEnd", effect.metadata);
        }
      }

      if (this.primaryEnded && liveEffectFrames.length === 0 && this.effects.size === 0) {
        this.push(null);
        return;
      }

      continuePulling = this.push(
        mixPcmFrames(
          primaryFrame,
          liveEffectFrames,
          this.musicVolume,
          this.effectVolume,
        ),
      );
    } catch (error) {
      this.destroy(error as Error);
    } finally {
      this.pulling = false;
      if (continuePulling && !this.destroyed) queueMicrotask(() => this._read());
    }
  }
}
