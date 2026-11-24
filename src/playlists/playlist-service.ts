import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { saveJson } from "../core/json-store.js";

import type { Playlist } from "../types.js";

interface PersistedPlaylists {
  version: 1;
  playlists: Playlist[];
}

export interface PlaylistUpdate {
  name?: string | undefined;
  description?: string | null | undefined;
}

function copyPlaylist(playlist: Playlist): Playlist {
  return {
    ...playlist,
    items: playlist.items.map((item) => ({ ...item })),
  };
}

function cleanDescription(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export class PlaylistService {
  private playlists: Playlist[] = [];
  private readonly metadataPath: string;

  constructor(dataDir: string) {
    this.metadataPath = path.join(dataDir, "playlists.json");
  }

  async initialize(): Promise<void> {
    await mkdir(path.dirname(this.metadataPath), { recursive: true });
    try {
      const persisted = JSON.parse(
        await readFile(this.metadataPath, "utf8"),
      ) as PersistedPlaylists;
      if (persisted.version === 1 && Array.isArray(persisted.playlists)) {
        this.playlists = persisted.playlists;
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
    this.sortPlaylists();
  }

  list(): Playlist[] {
    return this.playlists.map(copyPlaylist);
  }
  async importPlaylists(playlists: Playlist[]): Promise<void> { this.playlists = structuredClone(playlists); this.sortPlaylists(); await this.persist(); }

  get(playlistId: string): Playlist | null {
    const playlist = this.playlists.find(({ id }) => id === playlistId);
    return playlist ? copyPlaylist(playlist) : null;
  }

  async create(name: string, description?: string | null, trackIds: readonly string[] = []): Promise<Playlist> {
    const cleanName = name.trim();
    if (!cleanName) throw new Error("O nome da playlist nao pode ficar vazio.");
    const now = new Date().toISOString();
    const clean = cleanDescription(description);
    const playlist: Playlist = {
      id: randomUUID(),
      name: cleanName,
      ...(clean ? { description: clean } : {}),
      items: trackIds.map(trackId => ({ id: randomUUID(), trackId, addedAt: now })),
      createdAt: now,
      updatedAt: now,
    };
    this.playlists.push(playlist);
    this.sortPlaylists();
    await this.persist();
    return copyPlaylist(playlist);
  }

  async update(playlistId: string, update: PlaylistUpdate): Promise<Playlist> {
    const playlist = this.requirePlaylist(playlistId);
    if (update.name !== undefined) {
      const name = update.name.trim();
      if (!name) throw new Error("O nome da playlist nao pode ficar vazio.");
      playlist.name = name;
    }
    if (update.description !== undefined) {
      const description = cleanDescription(update.description);
      if (description) playlist.description = description;
      else delete playlist.description;
    }
    playlist.updatedAt = new Date().toISOString();
    this.sortPlaylists();
    await this.persist();
    return copyPlaylist(playlist);
  }

  async delete(playlistId: string): Promise<Playlist> {
    const index = this.playlists.findIndex(({ id }) => id === playlistId);
    const playlist = this.playlists[index];
    if (index < 0 || !playlist) throw new Error("Playlist nao encontrada.");
    this.playlists.splice(index, 1);
    await this.persist();
    return copyPlaylist(playlist);
  }

  async addItem(playlistId: string, trackId: string): Promise<Playlist> {
    const playlist = this.requirePlaylist(playlistId);
    playlist.items.push({
      id: randomUUID(),
      trackId,
      addedAt: new Date().toISOString(),
    });
    playlist.updatedAt = new Date().toISOString();
    await this.persist();
    return copyPlaylist(playlist);
  }

  async removeItem(playlistId: string, itemId: string): Promise<Playlist> {
    const playlist = this.requirePlaylist(playlistId);
    const index = playlist.items.findIndex(({ id }) => id === itemId);
    if (index < 0) throw new Error("Item da playlist nao encontrado.");
    playlist.items.splice(index, 1);
    playlist.updatedAt = new Date().toISOString();
    await this.persist();
    return copyPlaylist(playlist);
  }

  async reorder(playlistId: string, from: number, to: number): Promise<Playlist> {
    const playlist = this.requirePlaylist(playlistId);
    if (
      from < 0 ||
      to < 0 ||
      from >= playlist.items.length ||
      to >= playlist.items.length ||
      from === to
    ) {
      throw new Error("Nao foi possivel reordenar a playlist.");
    }
    const [item] = playlist.items.splice(from, 1);
    if (!item) throw new Error("Item da playlist nao encontrado.");
    playlist.items.splice(to, 0, item);
    playlist.updatedAt = new Date().toISOString();
    await this.persist();
    return copyPlaylist(playlist);
  }

  async removeTrack(trackId: string): Promise<boolean> {
    let changed = false;
    const now = new Date().toISOString();
    for (const playlist of this.playlists) {
      const filtered = playlist.items.filter((item) => item.trackId !== trackId);
      if (filtered.length !== playlist.items.length) {
        playlist.items = filtered;
        playlist.updatedAt = now;
        changed = true;
      }
    }
    if (changed) await this.persist();
    return changed;
  }

  async pruneMissingTracks(validTrackIds: ReadonlySet<string>): Promise<number> {
    let removed = 0;
    const now = new Date().toISOString();
    for (const playlist of this.playlists) {
      const filtered = playlist.items.filter(({ trackId }) => validTrackIds.has(trackId));
      const removedFromPlaylist = playlist.items.length - filtered.length;
      if (removedFromPlaylist > 0) {
        playlist.items = filtered;
        playlist.updatedAt = now;
        removed += removedFromPlaylist;
      }
    }
    if (removed > 0) await this.persist();
    return removed;
  }

  private requirePlaylist(playlistId: string): Playlist {
    const playlist = this.playlists.find(({ id }) => id === playlistId);
    if (!playlist) throw new Error("Playlist nao encontrada.");
    return playlist;
  }

  private sortPlaylists(): void {
    this.playlists.sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
  }

  private async persist(): Promise<void> {
    const payload: PersistedPlaylists = {
      version: 1,
      playlists: this.playlists,
    };
    await saveJson(this.metadataPath, payload);
  }
}
