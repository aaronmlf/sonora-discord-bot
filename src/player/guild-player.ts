import { EventEmitter } from "node:events";

import {
  AudioPlayerStatus,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  type AudioPlayer,
  type AudioResource,
  type VoiceConnection,
} from "@discordjs/voice";

import { TrackQueue, type CompletionReason } from "../core/queue.js";
import { AudioSourceFactory } from "../audio/audio-source-factory.js";
import { SessionMixer } from "../audio/session-mixer.js";
import type { Scene } from "../types.js";
import type {
  PlayerStatus,
  LibraryTrack,
  QueuedTrack,
  RepeatMode,
  SessionSnapshot,
} from "../types.js";

export interface GuildPlayerOptions {
  guildId: string;
  guildName: string;
  defaultVolume: number;
  defaultEffectVolume: number;
  idleTimeoutMs: number;
  audioSources: AudioSourceFactory;
}

export class GuildPlayer extends EventEmitter {
  readonly guildId: string;
  private guildName: string;
  private readonly player: AudioPlayer;
  private readonly queue = new TrackQueue();
  private readonly audioSources: AudioSourceFactory;
  private readonly idleTimeoutMs: number;
  private connection: VoiceConnection | null = null;
  private resource: AudioResource | null = null;
  private mixer: SessionMixer | null = null;
  private environmentVolume = 70;
  private ducking = false;
  private musicPaused = false;
  private musicBuffering = true;
  private recovery: SessionSnapshot | null = null;
  private voiceChannelId: string | undefined;
  private voiceChannelName: string | undefined;
  private status: PlayerStatus = "idle";
  private volume: number;
  private effectVolume: number;
  private startedAt: string | null = null;
  private pausedAt: string | null = null;
  private lastError: string | null = null;
  private stopping = false;
  private idleTimer: NodeJS.Timeout | null = null;
  private voiceTimer: NodeJS.Timeout | null = null;
  private voicePaused = false;
  private detachVoiceListeners: (() => void) | null = null;

  constructor(options: GuildPlayerOptions) {
    super();
    this.guildId = options.guildId;
    this.guildName = options.guildName;
    this.volume = options.defaultVolume;
    this.effectVolume = options.defaultEffectVolume;
    this.audioSources = options.audioSources;
    this.idleTimeoutMs = options.idleTimeoutMs;
    this.player = createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Pause },
    });

    this.player.on(AudioPlayerStatus.Buffering, () => {
      if (this.queue.current && !this.musicPaused) this.status = "buffering";
      this.emitUpdate();
    });
    this.player.on(AudioPlayerStatus.Playing, () => {
      this.syncMusicStatus();
      this.clearIdleTimer();
      this.emitUpdate();
    });
    this.player.on(AudioPlayerStatus.Paused, () => {
      this.status = "paused";
      this.pausedAt ??= new Date().toISOString();
      this.emitUpdate();
    });
    this.player.on(AudioPlayerStatus.AutoPaused, () => {
      this.status = "paused";
      this.pausedAt ??= new Date().toISOString();
      this.emitUpdate();
    });
    this.player.on(AudioPlayerStatus.Idle, () => {
      // The mixer is a continuous stream, so Idle is not normal track completion.
      // A closed encoder/underrun used to leave the queue stuck on "playing".
      if (!this.stopping && this.mixer) this.failPlayback(new Error("O fluxo de áudio foi interrompido. A fila continuará com a próxima faixa."));
    });
    this.player.on("error", (error) => {
      this.failPlayback(error);
    });
  }

  setGuildName(name: string): void {
    this.guildName = name;
  }

  attachConnection(
    connection: VoiceConnection,
    channel: { id: string; name: string },
  ): void {
    if (this.connection === connection) {
      this.voiceChannelId = channel.id;
      this.voiceChannelName = channel.name;
      connection.subscribe(this.player);
      if (connection.state.status === VoiceConnectionStatus.Ready) this.resumeVoice();
      if (!this.queue.current) this.scheduleIdleDisconnect();
      this.emitUpdate();
      return;
    }
    this.detachVoiceListeners?.();
    this.detachVoiceListeners = null;
    this.clearVoiceTimer();
    if (this.connection && this.connection !== connection) {
      this.connection.destroy();
    }
    this.connection = connection;
    this.voiceChannelId = channel.id;
    this.voiceChannelName = channel.name;
    connection.subscribe(this.player);
    const onDestroyed = (): void => {
      if (this.connection === connection) {
        this.clearVoiceTimer();
        this.pauseVoice("A conexão de voz foi encerrada. Use /join para reconectar e continuar a fila.");
        this.connection = null;
        this.voiceChannelId = undefined;
        this.voiceChannelName = undefined;
        this.emitUpdate();
      }
      this.detachVoiceListeners?.(); this.detachVoiceListeners = null;
    };
    const onStateChange = (): void => {
      if (this.connection !== connection || connection.state.status === VoiceConnectionStatus.Destroyed) return;
      if (connection.state.status === VoiceConnectionStatus.Ready) {
        this.clearVoiceTimer(); this.resumeVoice();
      } else {
        this.pauseVoice("Aguardando a conexão de voz se recuperar. A fila foi preservada.");
        if (!this.voiceTimer) {
          this.voiceTimer = setTimeout(() => {
            this.voiceTimer = null;
            if (this.connection === connection && connection.state.status !== VoiceConnectionStatus.Ready && connection.state.status !== VoiceConnectionStatus.Destroyed) connection.destroy();
          }, 20_000);
          this.voiceTimer.unref();
        }
      }
    };
    const onError = (error: Error): void => {
      if (this.connection !== connection) return;
      this.lastError = `Falha na conexão de voz: ${error.message}`; this.emitUpdate();
    };
    connection.on(VoiceConnectionStatus.Destroyed, onDestroyed);
    connection.on("stateChange", onStateChange);
    connection.on("error", onError);
    this.detachVoiceListeners = () => {
      connection.off(VoiceConnectionStatus.Destroyed, onDestroyed);
      connection.off("stateChange", onStateChange);
      connection.off("error", onError);
    };
    onStateChange();
    if (!this.queue.current) this.scheduleIdleDisconnect();
    this.emitUpdate();
  }

  enqueue(track: QueuedTrack, next = false): void {
    this.queue.enqueue(track, next);
    this.emitUpdate();
    if (!this.queue.current) this.startNext();
  }

  enqueueMany(tracks: QueuedTrack[]): void {
    if (!tracks.length) return;
    for (const track of tracks) this.queue.enqueue(track);
    if (!this.queue.current) this.startNext();
    else this.emitUpdate();
  }

  playEffect(track: QueuedTrack): void {
    const decoded = this.audioSources.create(track);
    try { this.ensureMixer().addEffect(track, decoded); }
    catch (error) { decoded.dispose(); throw error; }
    this.clearIdleTimer();
    this.emitUpdate();
  }

  pause(): boolean {
    if (!this.queue.current || this.status === "paused") return false;
    this.musicPaused = true; this.mixer?.pauseMusic(true); this.syncMusicStatus(); this.emitUpdate(); return true;
  }

  resume(): boolean {
    if (!this.queue.current || this.status !== "paused") return false;
    if (this.voicePaused) return false;
    this.musicPaused = false; this.mixer?.pauseMusic(false); this.syncMusicStatus(); this.emitUpdate(); return true;
  }

  skip(): boolean {
    if (!this.queue.current) return false;
    this.mixer?.setMusic(null, null);
    this.advance("skipped");
    return true;
  }

  stop(): void {
    this.musicPaused = false;
    this.stopping = true;
    this.queue.reset();
    this.mixer?.destroy();
    this.mixer = null;
    this.resource = null;
    this.startedAt = null;
    this.pausedAt = null;
    this.lastError = null;
    this.status = "idle";
    this.player.stop(true); this.stopping = false;
    this.scheduleIdleDisconnect();
    this.emitUpdate();
  }
  stopMusic(): void {
    this.queue.reset(); this.mixer?.setMusic(null, null); this.musicPaused = false;
    this.startedAt = null; this.pausedAt = null; this.status = "idle";
    this.scheduleIdleDisconnect(); this.emitUpdate();
  }

  leave(): void {
    this.stop();
    this.clearIdleTimer();
    this.clearVoiceTimer();
    this.detachVoiceListeners?.(); this.detachVoiceListeners = null;
    this.voicePaused = false;
    if (this.connection?.state.status !== VoiceConnectionStatus.Destroyed) {
      this.connection?.destroy();
    }
    this.connection = null;
    this.voiceChannelId = undefined;
    this.voiceChannelName = undefined;
    this.emitUpdate();
  }

  setRepeatMode(mode: RepeatMode): void {
    this.queue.setRepeatMode(mode);
    this.emitUpdate();
  }

  setVolume(volume: number): void {
    this.volume = Math.max(0, Math.min(100, Math.round(volume)));
    this.mixer?.setMusicVolume(this.volume);
    this.emitUpdate();
  }

  setEffectVolume(volume: number): void {
    this.effectVolume = Math.max(0, Math.min(150, Math.round(volume)));
    this.mixer?.setEffectVolume(this.effectVolume);
    this.emitUpdate();
  }

  clearUpcoming(): void {
    this.queue.clearUpcoming();
    this.emitUpdate();
  }

  remove(index: number): boolean {
    const removed = this.queue.remove(index);
    if (removed) this.emitUpdate();
    return Boolean(removed);
  }

  playUpcoming(index: number): boolean {
    if (!this.queue.selectUpcoming(index)) return false;
    if (this.queue.current) return this.skip();
    this.startNext(); return true;
  }

  entryAction(id: string, action: "play" | "remove" | "before", beforeId?: string): boolean {
    const index = this.queue.indexOf(id);
    if (index < 0) return false;
    if (action === "play") return this.playUpcoming(index);
    if (action === "remove") return this.remove(index);
    const to = beforeId ? this.queue.indexOf(beforeId) : this.queue.upcoming.length - 1;
    if (to < 0) return false;
    return this.reorder(index, beforeId && index < to ? to - 1 : to);
  }
  shuffle(): void { this.queue.shuffle(); this.emitUpdate(); }
  setEnvironmentVolume(value: number): void { this.environmentVolume = Math.max(0, Math.min(100, value)); this.mixer?.setEnvironmentVolume(this.environmentVolume); this.emitUpdate(); }
  setDucking(value: boolean): void { this.ducking = value; this.mixer?.setDucking(value); this.emitUpdate(); }
  stopLayer(id: string): void { this.mixer?.stopLayer(id); }
  setLayerVolume(id: string, volume: number): void { if (!this.mixer?.setLayerVolume(id, volume)) throw new Error("Ambiente não encontrado."); }
  stopEffects(): void { this.mixer?.stopEffects(); }
  addEnvironment(track: LibraryTrack, volume: number): void {
    const decoded = this.audioSources.create(track, true);
    try { this.ensureMixer().addEnvironment(track, decoded, volume); }
    catch (error) { decoded.dispose(); throw error; }
    this.clearIdleTimer(); this.emitUpdate();
  }
  activateScene(scene: Scene, music: QueuedTrack[], environments: LibraryTrack[]): void {
    let mixer: SessionMixer;
    const decoded: { track: LibraryTrack; decoded: ReturnType<AudioSourceFactory["create"]>; volume: number }[] = [];
    let musicDecoded: ReturnType<AudioSourceFactory["create"]> | null = null;
    try {
      for (const [index, track] of environments.entries()) decoded.push({ track, decoded: this.audioSources.create(track, true), volume: scene.environments[index]!.volume });
      if (music[0]) musicDecoded = this.audioSources.create(music[0]);
      mixer = this.ensureMixer();
    } catch (error) { decoded.forEach(item => item.decoded.dispose()); musicDecoded?.dispose(); throw error; }
    this.queue.reset(); music.forEach(track => this.queue.enqueue(track));
    const first = this.queue.beginNext();
    this.musicPaused = false; this.musicBuffering = true; this.startedAt = null; this.pausedAt = null;
    this.setVolume(scene.musicVolume); this.setEffectVolume(scene.effectVolume); this.setEnvironmentVolume(scene.environmentVolume); this.setDucking(scene.ducking);
    mixer.setMusic(first, musicDecoded, scene.transitionMs);
    mixer.replaceEnvironments(decoded, scene.transitionMs);
    this.musicPaused = false; this.lastError = null;
    this.status = first ? "buffering" : "idle"; this.syncMusicStatus();
    this.clearIdleTimer(); this.scheduleIdleDisconnect(); this.emitUpdate();
  }
  offerRecovery(snapshot: SessionSnapshot): void {
    this.recovery = structuredClone(snapshot); this.volume = snapshot.volume; this.effectVolume = snapshot.effectVolume;
    this.environmentVolume = snapshot.environmentVolume ?? 70; this.ducking = snapshot.ducking ?? false; this.queue.setRepeatMode(snapshot.repeatMode);
  }
  recoverySnapshot(): SessionSnapshot | null { return this.recovery ? structuredClone(this.recovery) : null; }
  restoreRecovery(resolve: (track: QueuedTrack) => QueuedTrack | null): void {
    if (!this.recovery) throw new Error("Nenhuma fila para restaurar.");
    if (this.queue.current || this.queue.upcoming.length) throw new Error("Limpe a fila atual antes de restaurar.");
    const tracks = [this.recovery.current, ...this.recovery.upcoming].filter((t): t is QueuedTrack => Boolean(t)).map(resolve).filter((t): t is QueuedTrack => Boolean(t));
    this.recovery = null; this.enqueueMany(tracks); this.emitUpdate();
  }
  discardRecovery(): void { this.recovery = null; this.emitUpdate(); }

  removeTrack(trackId: string): void {
    this.mixer?.removeTrack(trackId);
    const isCurrent = this.queue.current?.source === "local" && this.queue.current.id === trackId;
    const removed = this.queue.removeByTrackId(trackId);
    if (isCurrent) {
      this.skip();
    } else if (removed > 0) {
      this.emitUpdate();
    }
  }

  updateTrack(track: LibraryTrack): void {
    if (this.queue.replaceLibraryTrack(track)) this.emitUpdate();
  }

  reorder(from: number, to: number): boolean {
    const reordered = this.queue.reorder(from, to);
    if (reordered) this.emitUpdate();
    return reordered;
  }

  hasConnectionTo(channelId: string): boolean {
    return this.connection !== null && this.voiceChannelId === channelId;
  }

  getSnapshot(): SessionSnapshot {
    return {
      guildId: this.guildId,
      environmentVolume: this.environmentVolume,
      environments: this.mixer?.activeEnvironments() ?? [],
      ducking: this.ducking,
      recoveryAvailable: Boolean(this.recovery),
      guildName: this.guildName,
      ...(this.voiceChannelId ? { voiceChannelId: this.voiceChannelId } : {}),
      ...(this.voiceChannelName ? { voiceChannelName: this.voiceChannelName } : {}),
      status: this.status,
      current: this.queue.current ? { ...this.queue.current } : null,
      upcoming: this.queue.upcoming.map((track) => ({ ...track })),
      repeatMode: this.queue.repeatMode,
      volume: this.volume,
      effectVolume: this.effectVolume,
      activeEffects: this.mixer?.activeEffects() ?? [],
      startedAt: this.startedAt,
      pausedAt: this.pausedAt,
      error: this.lastError,
    };
  }

  private startNext(): void {
    const track = this.queue.beginNext();
    if (!track) {
      this.status = "idle";
      this.startedAt = null;
      this.pausedAt = null;
      this.scheduleIdleDisconnect();
      this.emitUpdate();
      return;
    }

    try {
      const decoded = this.audioSources.create(track);
      let mixer: SessionMixer;
      try { mixer = this.ensureMixer(); }
      catch (error) { decoded.dispose(); throw error; }
      this.musicPaused = false; this.musicBuffering = true;
      this.startedAt = null; this.pausedAt = null;
      mixer.setMusic(track, decoded);
      this.syncMusicStatus();
      this.lastError = null;
      this.clearIdleTimer();
      this.emitUpdate();
    } catch (error) {
      this.lastError = (error as Error).message;
      this.status = "error";
      this.emitUpdate();
      const entryId = track.entryId;
      queueMicrotask(() => { if (this.queue.current?.entryId === entryId) this.advance("failed"); });
    }
  }

  private advance(reason: CompletionReason): void {
    this.startedAt = null;
    this.pausedAt = null;
    this.musicPaused = false;
    const next = this.queue.complete(reason);
    if (next) {
      this.startNext();
    } else {
      this.status = this.lastError ? "error" : "idle";
      this.scheduleIdleDisconnect();
      this.emitUpdate();
    }
  }

  private scheduleIdleDisconnect(): void {
    this.clearIdleTimer();
    if (!this.connection || this.idleTimeoutMs <= 0 || this.queue.current || this.mixer?.activeEffects().length || this.mixer?.activeEnvironments().length) return;
    this.idleTimer = setTimeout(() => this.leave(), this.idleTimeoutMs);
    this.idleTimer.unref();
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private clearVoiceTimer(): void {
    if (this.voiceTimer) clearTimeout(this.voiceTimer);
    this.voiceTimer = null;
  }

  private pauseVoice(message: string): void {
    if (!this.voicePaused) {
      this.voicePaused = true;
      this.player.pause(true);
      this.syncMusicStatus();
    }
    this.lastError = message; this.emitUpdate();
  }

  private resumeVoice(): void {
    if (!this.voicePaused) return;
    this.voicePaused = false;
    this.lastError = null;
    this.player.unpause();
    this.syncMusicStatus();
    this.emitUpdate();
  }

  private syncMusicStatus(): void {
    if (!this.queue.current) {
      this.status = this.voicePaused ? "paused" : this.lastError ? "error" : "idle";
      this.startedAt = null; this.pausedAt = null;
      return;
    }
    if (this.musicPaused || this.voicePaused || this.musicBuffering) {
      this.pausedAt ??= new Date().toISOString();
      this.status = this.musicPaused || this.voicePaused ? "paused" : "buffering";
      return;
    }
    if (this.startedAt && this.pausedAt) this.startedAt = new Date(Date.parse(this.startedAt) + Date.now() - Date.parse(this.pausedAt)).toISOString();
    this.startedAt ??= new Date().toISOString(); this.pausedAt = null; this.status = "playing";
  }

  private failPlayback(error: Error): void {
    this.lastError = error.message; this.status = "error";
    const entryId = this.queue.current?.entryId;
    this.mixer?.destroy(); this.mixer = null; this.resource = null;
    this.emitUpdate();
    queueMicrotask(() => {
      if (entryId && this.queue.current?.entryId === entryId) this.advance("failed");
      else this.scheduleIdleDisconnect();
    });
  }

  private emitUpdate(): void {
    this.emit("update", this.getSnapshot());
  }

  private ensureMixer(): SessionMixer {
    if (this.mixer && !this.mixer.destroyed) return this.mixer;
    const mixer = new SessionMixer(); this.mixer = mixer;
    mixer.setMusicVolume(this.volume); mixer.setEffectVolume(this.effectVolume); mixer.setEnvironmentVolume(this.environmentVolume); mixer.setDucking(this.ducking);
    mixer.on("musicState", (state: "buffering" | "playing") => {
      if (this.mixer !== mixer) return;
      this.musicBuffering = state === "buffering";
      this.syncMusicStatus(); this.emitUpdate();
    });
    mixer.on("musicEnd", (error: Error | null) => {
      if (error) this.lastError = error.message;
      this.advance(error ? "failed" : "finished");
    });
    mixer.on("layers", () => { this.scheduleIdleDisconnect(); this.emitUpdate(); });
    mixer.on("sourceError", (error: Error) => { this.lastError = error.message; this.emitUpdate(); });
    try {
      this.resource = createAudioResource(mixer, { inputType: StreamType.Raw });
      this.player.play(this.resource);
      if (this.voicePaused) this.player.pause(true);
      return mixer;
    } catch (error) {
      mixer.destroy(); this.mixer = null; this.resource = null; throw error;
    }
  }
}
