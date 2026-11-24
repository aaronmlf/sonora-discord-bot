import type { LibraryTrack, QueuedTrack, RepeatMode } from "../types.js";
import { randomUUID } from "node:crypto";

export type CompletionReason = "finished" | "skipped" | "failed";

export class TrackQueue {
  private currentTrack: QueuedTrack | null = null;
  private pendingTracks: QueuedTrack[] = [];
  private mode: RepeatMode = "off";

  get current(): QueuedTrack | null {
    return this.currentTrack;
  }

  get upcoming(): readonly QueuedTrack[] {
    return this.pendingTracks;
  }

  get repeatMode(): RepeatMode {
    return this.mode;
  }

  enqueue(track: QueuedTrack, next = false): void {
    track = { ...track, entryId: randomUUID() };
    if (next) {
      this.pendingTracks.unshift(track);
      return;
    }
    this.pendingTracks.push(track);
  }

  beginNext(): QueuedTrack | null {
    if (this.currentTrack) return this.currentTrack;
    this.currentTrack = this.pendingTracks.shift() ?? null;
    return this.currentTrack;
  }

  complete(reason: CompletionReason): QueuedTrack | null {
    const completed = this.currentTrack;
    this.currentTrack = null;

    if (completed && reason !== "failed") {
      if (this.mode === "track" && reason === "finished") {
        this.pendingTracks.unshift(completed);
      } else if (this.mode === "queue") {
        this.pendingTracks.push(completed);
      }
    }

    return this.beginNext();
  }

  setRepeatMode(mode: RepeatMode): void {
    this.mode = mode;
  }

  remove(index: number): QueuedTrack | null {
    if (!Number.isInteger(index) || index < 0 || index >= this.pendingTracks.length) {
      return null;
    }
    return this.pendingTracks.splice(index, 1)[0] ?? null;
  }

  selectUpcoming(index: number): QueuedTrack | null {
    if (!Number.isInteger(index) || index < 0 || index >= this.pendingTracks.length) {
      return null;
    }
    if (index > 0) this.pendingTracks.splice(0, index);
    return this.pendingTracks[0] ?? null;
  }

  removeByTrackId(trackId: string): number {
    const before = this.pendingTracks.length;
    this.pendingTracks = this.pendingTracks.filter(({ id }) => id !== trackId);
    return before - this.pendingTracks.length;
  }

  replaceLibraryTrack(track: LibraryTrack): boolean {
    let changed = false;
    const replace = (queued: QueuedTrack): QueuedTrack => {
      if (queued.source !== "local" || queued.id !== track.id) return queued;
      changed = true;
      return {
        ...track,
        ...(queued.entryId ? { entryId: queued.entryId } : {}),
        requestedBy: queued.requestedBy,
        requestedAt: queued.requestedAt,
      };
    };
    if (this.currentTrack) this.currentTrack = replace(this.currentTrack);
    this.pendingTracks = this.pendingTracks.map(replace);
    return changed;
  }

  reorder(from: number, to: number): boolean {
    if (
      !Number.isInteger(from) ||
      !Number.isInteger(to) ||
      from < 0 ||
      to < 0 ||
      from >= this.pendingTracks.length ||
      to >= this.pendingTracks.length ||
      from === to
    ) {
      return false;
    }

    const [track] = this.pendingTracks.splice(from, 1);
    if (!track) return false;
    this.pendingTracks.splice(to, 0, track);
    return true;
  }

  clearUpcoming(): void {
    this.pendingTracks = [];
  }

  indexOf(entryId: string): number {
    return this.pendingTracks.findIndex((track) => track.entryId === entryId);
  }

  shuffle(): void {
    for (let index = this.pendingTracks.length - 1; index > 0; index--) {
      const target = Math.floor(Math.random() * (index + 1));
      [this.pendingTracks[index], this.pendingTracks[target]] = [this.pendingTracks[target]!, this.pendingTracks[index]!];
    }
  }

  reset(): void {
    this.currentTrack = null;
    this.pendingTracks = [];
  }
}
