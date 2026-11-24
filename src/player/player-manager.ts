import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { saveJson } from "../core/json-store.js";

import type { VoiceConnection } from "@discordjs/voice";

import { AudioSourceFactory } from "../audio/audio-source-factory.js";
import type { LibraryTrack, SessionSnapshot } from "../types.js";
import { GuildPlayer } from "./guild-player.js";

export interface PlayerManagerOptions {
  dataDir?: string;
  audioSources: AudioSourceFactory;
  defaultVolume: number;
  defaultEffectVolume: number;
  idleTimeoutMs: number;
}

export class PlayerManager extends EventEmitter {
  private readonly players = new Map<string, GuildPlayer>();
  private saving = true;
  private writeTask: Promise<void> = Promise.resolve();
  private persistenceError: Error | null = null;

  async initialize(): Promise<void> {
    if (!this.options.dataDir) return;
    this.saving = false;
    try {
      const data = JSON.parse(await readFile(path.join(this.options.dataDir, "sessions.json"), "utf8")) as { version: number; sessions: SessionSnapshot[]; recoveries?: Record<string, SessionSnapshot> };
      if (data.version !== 1 || !Array.isArray(data.sessions)) throw new Error("Formato de recuperação de sessões inválido.");
      for (const snapshot of data.sessions) {
        const player = this.getOrCreate(snapshot.guildId, snapshot.guildName);
        const recovery = snapshot.current || snapshot.upcoming.length ? snapshot : data.recoveries?.[snapshot.guildId] ?? snapshot;
        player.offerRecovery({ ...recovery, volume: snapshot.volume, effectVolume: snapshot.effectVolume, repeatMode: snapshot.repeatMode, environmentVolume: snapshot.environmentVolume ?? 70, ducking: snapshot.ducking ?? false });
        if (!recovery.current && !recovery.upcoming.length) player.discardRecovery();
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    finally { this.saving = true; }
  }

  private persist(): void {
    if (!this.saving || !this.options.dataDir) return;
    const sessions = [...this.players.values()].map(player => player.getSnapshot());
    const recoveries = Object.fromEntries([...this.players.values()].flatMap(player => { const recovery = player.recoverySnapshot(); return recovery ? [[player.guildId, recovery]] : []; }));
    this.writeTask = saveJson(path.join(this.options.dataDir, "sessions.json"), { version: 1, sessions, recoveries });
    void this.writeTask.then(() => { this.persistenceError = null; }, error => { this.persistenceError = error; this.emit("persistenceError", error); });
  }
  getPersistenceError(): string | null { return this.persistenceError?.message ?? null; }
  exportSessions(): SessionSnapshot[] {
    return [...this.players.values()].map(player => {
      const snapshot = player.getSnapshot();
      const recovery = player.recoverySnapshot();
      if (snapshot.current || snapshot.upcoming.length || !recovery) return snapshot;
      // Preserve the offered queue, but export settings as they are now rather
      // than restoring obsolete volume/repeat settings with a future backup.
      return { ...snapshot, current: recovery.current, upcoming: recovery.upcoming };
    });
  }
  async importSessions(sessions: SessionSnapshot[]): Promise<void> {
    this.shutdown(); await this.flush(); this.saving = false;
    for (const snapshot of sessions) { const player = this.getOrCreate(snapshot.guildId, snapshot.guildName); player.offerRecovery(snapshot); if (!snapshot.current && !snapshot.upcoming.length) player.discardRecovery(); }
    this.saving = true; await this.checkpoint();
  }
  async checkpoint(): Promise<void> { this.persist(); await this.writeTask; }

  constructor(private readonly options: PlayerManagerOptions) {
    super();
  }

  getOrCreate(guildId: string, guildName: string): GuildPlayer {
    const existing = this.players.get(guildId);
    if (existing) {
      existing.setGuildName(guildName);
      return existing;
    }

    const player = new GuildPlayer({
      guildId,
      guildName,
      audioSources: this.options.audioSources,
      defaultVolume: this.options.defaultVolume,
      defaultEffectVolume: this.options.defaultEffectVolume,
      idleTimeoutMs: this.options.idleTimeoutMs,
    });
    player.on("update", (snapshot: SessionSnapshot) => {
      this.emit("update", snapshot);
      this.persist();
    });
    this.players.set(guildId, player);
    this.emit("update", player.getSnapshot());
    return player;
  }

  get(guildId: string): GuildPlayer | null {
    return this.players.get(guildId) ?? null;
  }

  list(): SessionSnapshot[] {
    return [...this.players.values()]
      .map((player) => player.getSnapshot())
      .sort((a, b) => a.guildName.localeCompare(b.guildName, "pt-BR"));
  }

  attachConnection(
    guildId: string,
    guildName: string,
    connection: VoiceConnection,
    channel: { id: string; name: string },
  ): GuildPlayer {
    const player = this.getOrCreate(guildId, guildName);
    player.attachConnection(connection, channel);
    return player;
  }

  removeTrack(trackId: string): void {
    for (const player of this.players.values()) player.removeTrack(trackId);
  }

  updateTrack(track: LibraryTrack): void {
    for (const player of this.players.values()) player.updateTrack(track);
  }

  shutdown(): void {
    this.persist();
    this.saving = false;
    for (const player of this.players.values()) player.leave();
    this.players.clear();
  }
  async flush(): Promise<void> { await this.writeTask; }
}
