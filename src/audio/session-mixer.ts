import { Readable } from "node:stream";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { PCM_FRAME_BYTES, PCM_FRAME_DURATION_MS, type DecodedAudio } from "./pcm-mixer.js";
import type { ActiveEffect, PlayableTrack } from "../types.js";

// Each decoder has bounded buffering. A slow or broken effect never blocks music.
class Input {
  buffer: Buffer = Buffer.alloc(0);
  ended = false;
  error: Error | null = null;
  disposed = false;
  constructor(readonly decoded: DecodedAudio) {
    decoded.stream.on("data", (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      if (this.buffer.length >= PCM_FRAME_BYTES * 8) decoded.stream.pause();
    });
    decoded.stream.on("end", () => { this.ended = true; });
    decoded.stream.on("error", (error: Error) => { this.error = error; this.ended = true; });
    decoded.stream.on("close", () => { this.ended = true; });
  }
  frame(): Buffer | null {
    if (!this.buffer.length) return null;
    if (this.buffer.length < PCM_FRAME_BYTES && !this.ended) return null;
    const frame = Buffer.alloc(PCM_FRAME_BYTES);
    const count = Math.min(this.buffer.length, PCM_FRAME_BYTES);
    this.buffer.copy(frame, 0, 0, count);
    this.buffer = this.buffer.subarray(count);
    if (this.buffer.length < PCM_FRAME_BYTES * 4 && !this.ended) this.decoded.stream.resume();
    return frame;
  }
  get done(): boolean { return this.ended && !this.buffer.length; }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.decoded.dispose(); this.buffer = Buffer.alloc(0); this.ended = true;
  }
}

interface Layer { source: Input; metadata: ActiveEffect & { volume: number }; fade: number; fadeFrames: number; retiring: boolean; bus: "music" | "environment" | "effect" }

export class SessionMixer extends Readable {
  private music: Layer | null = null;
  private environments = new Map<string, Layer>();
  private effects = new Map<string, Layer>();
  private retired: Layer[] = [];
  private timer: NodeJS.Timeout | null = null;
  private nextFrameAt: number | null = null;
  private musicPaused = false;
  private musicState: "buffering" | "playing" | null = null;
  private musicVolume = 70;
  private effectVolume = 100;
  private environmentVolume = 70;
  private ducking = false;
  private duckGain = 1;

  constructor() { super({ highWaterMark: PCM_FRAME_BYTES * 4 }); }
  setMusicVolume(value: number): void { this.musicVolume = value; }
  setEffectVolume(value: number): void { this.effectVolume = value; }
  setEnvironmentVolume(value: number): void { this.environmentVolume = value; }
  setDucking(value: boolean): void { this.ducking = value; }
  pauseMusic(value: boolean): void { this.musicPaused = value; }
  private layer(track: PlayableTrack, decoded: DecodedAudio, volume: number, transitionMs = 0, bus: Layer["bus"] = "effect"): Layer {
    return { source: new Input(decoded), metadata: { playbackId: randomUUID(), trackId: track.id, title: track.title, startedAt: new Date().toISOString(), volume }, fade: transitionMs ? 0 : 1, fadeFrames: Math.max(1, Math.round(transitionMs / 20)), retiring: false, bus };
  }
  private retire(layer: Layer | null, transitionMs: number): void {
    if (!layer) return;
    if (!transitionMs) { layer.source.dispose(); return; }
    layer.retiring = true; layer.fadeFrames = Math.max(1, Math.round(transitionMs / 20)); this.retired.push(layer);
  }
  setMusic(track: PlayableTrack | null, decoded: DecodedAudio | null, transitionMs = 0): void {
    // Bound resources if several scenes are activated during a transition.
    for (const layer of this.retired.filter(l => l.bus === "music")) layer.source.dispose(); this.retired = this.retired.filter(l => l.bus !== "music");
    this.retire(this.music, transitionMs);
    this.music = track && decoded ? this.layer(track, decoded, 100, transitionMs, "music") : null;
    this.musicPaused = false;
    this.musicState = null;
    if (this.music) this.setMusicState("buffering");
  }
  private setMusicState(state: "buffering" | "playing"): void {
    if (this.musicState === state) return;
    this.musicState = state;
    this.emit("musicState", state);
  }
  replaceEnvironments(tracks: { track: PlayableTrack; decoded: DecodedAudio; volume: number }[], transitionMs = 0): void {
    if (tracks.length > 3) { tracks.forEach(t => t.decoded.dispose()); throw new Error("Máximo de três ambientes."); }
    for (const layer of this.retired.filter(l => l.bus === "environment")) layer.source.dispose(); this.retired = this.retired.filter(l => l.bus !== "environment");
    for (const layer of this.environments.values()) this.retire(layer, transitionMs);
    this.environments.clear();
    for (const item of tracks) {
      const layer = this.layer(item.track, item.decoded, item.volume, transitionMs, "environment");
      this.environments.set(layer.metadata.playbackId, layer);
    }
    this.emit("layers");
  }
  addEnvironment(track: PlayableTrack, decoded: DecodedAudio, volume: number): void {
    if (this.environments.size >= 3) { decoded.dispose(); throw new Error("Máximo de três ambientes."); }
    const layer = this.layer(track, decoded, volume, 0, "environment"); this.environments.set(layer.metadata.playbackId, layer); this.emit("layers");
  }
  addEffect(track: PlayableTrack, decoded: DecodedAudio): ActiveEffect {
    if (this.effects.size >= 8) { decoded.dispose(); throw new Error("Máximo de oito efeitos simultâneos."); }
    const layer = this.layer(track, decoded, 100); this.effects.set(layer.metadata.playbackId, layer); this.emit("layers"); return layer.metadata;
  }
  activeEffects(): ActiveEffect[] { return [...this.effects.values()].map(l => ({ ...l.metadata })); }
  activeEnvironments(): (ActiveEffect & { volume: number })[] { return [...this.environments.values()].map(l => ({ ...l.metadata })); }
  stopLayer(id: string): void {
    for (const group of [this.effects, this.environments]) {
      const layer = group.get(id); if (layer) { layer.source.dispose(); group.delete(id); }
    }
    this.emit("layers");
  }
  stopEffects(): void { for (const id of this.effects.keys()) this.stopLayer(id); }
  setLayerVolume(id: string, volume: number): boolean {
    const layer = this.environments.get(id); if (!layer) return false;
    layer.metadata.volume = Math.max(0, Math.min(100, volume)); this.emit("layers"); return true;
  }
  removeTrack(id: string): void {
    for (const group of [this.effects, this.environments]) for (const [key, layer] of group) if (layer.metadata.trackId === id) this.stopLayer(key);
    for (const layer of this.retired.filter(layer => layer.metadata.trackId === id)) layer.source.dispose();
    this.retired = this.retired.filter(layer => layer.metadata.trackId !== id);
  }
  override _read(): void {
    if (this.timer || this.destroyed) return;
    // Keep two frames ahead of the voice clock. Relative 20 ms timers also
    // include rendering time and gradually fall behind Discord's clock.
    this.nextFrameAt ??= performance.now() - PCM_FRAME_DURATION_MS * 2;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.destroyed) return;
      // Recover small scheduling delays, but never render an unbounded backlog
      // after a suspended process or a stalled event loop.
      this.nextFrameAt = Math.max(this.nextFrameAt!, performance.now() - PCM_FRAME_DURATION_MS * 3);
      let produced = 0;
      while (!this.destroyed && produced < 4 && this.nextFrameAt <= performance.now()) {
        this.nextFrameAt += PCM_FRAME_DURATION_MS;
        produced++;
        if (!this.push(this.renderFrame())) {
          // Backpressure stops the clock; resume from the present on demand.
          this.nextFrameAt = null;
          return;
        }
      }
      this._read();
    }, Math.max(0, this.nextFrameAt - performance.now()));
  }
  // One frame of the three buses; exposed for deterministic mixer tests.
  renderFrame(): Buffer {
    const samples = new Float64Array(PCM_FRAME_BYTES / 2);
    const add = (layer: Layer, volume: number): boolean => {
      const frame = layer.source.frame();
      if (!frame) return false;
      layer.fade = Math.max(0, Math.min(1, layer.fade + (layer.retiring ? -1 : 1) / layer.fadeFrames));
      const gain = volume / 100 * layer.metadata.volume / 100 * layer.fade;
      for (let i = 0; i < samples.length; i++) samples[i] = samples[i]! + frame.readInt16LE(i * 2) * gain;
      return true;
    };
    const duckTarget = this.ducking && this.effects.size ? 0.3 : 1;
    this.duckGain += Math.sign(duckTarget - this.duckGain) * Math.min(0.07, Math.abs(duckTarget - this.duckGain));
    if (this.music && !this.musicPaused) {
      const music = this.music;
      const hasFrame = add(music, this.musicVolume * this.duckGain);
      if (hasFrame) this.setMusicState("playing");
      else if (!music.source.done) this.setMusicState("buffering");
      if (music.source.done) {
        this.music = null; this.musicState = null; music.source.dispose(); this.emit("musicEnd", music.source.error);
      }
    }
    for (const [group, volume] of [[this.environments, this.environmentVolume], [this.effects, this.effectVolume]] as const) {
      for (const [id, layer] of group) {
        add(layer, volume);
        if (layer.source.done) {
          group.delete(id); layer.source.dispose();
          if (layer.source.error) this.emit("sourceError", layer.source.error);
          this.emit("layers");
        }
      }
    }
    for (const layer of [...this.retired]) {
      if (layer.bus === "music" && this.musicPaused) continue;
      add(layer, layer.bus === "music" ? this.musicVolume * this.duckGain : this.environmentVolume);
      if (layer.fade <= 0 || layer.source.done) { layer.source.dispose(); this.retired = this.retired.filter(item => item !== layer); }
    }
    const output = Buffer.alloc(PCM_FRAME_BYTES);
    for (let i = 0; i < samples.length; i++) output.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i]!))), i * 2);
    return output;
  }
  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null; this.nextFrameAt = null;
    this.music?.source.dispose();
    for (const layer of [...this.effects.values(), ...this.environments.values(), ...this.retired]) layer.source.dispose();
    this.effects.clear(); this.environments.clear(); this.retired = []; callback(error);
  }
}
