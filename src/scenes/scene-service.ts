import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { saveJson } from "../core/json-store.js";
import type { Scene } from "../types.js";

export const sceneSchema = z.object({
  name: z.string().trim().min(1).max(100),
  playlistId: z.string().min(1).nullable().default(null),
  environments: z.array(z.object({ trackId: z.string().min(1), volume: z.number().min(0).max(100) })).max(3).default([]),
  effectIds: z.array(z.string().min(1)).max(100).default([]),
  musicVolume: z.number().min(0).max(100).default(70),
  environmentVolume: z.number().min(0).max(100).default(70),
  effectVolume: z.number().min(0).max(150).default(100),
  ducking: z.boolean().default(false),
  transitionMs: z.number().int().min(0).max(10000).default(2000),
});
export class SceneService {
  private scenes: Scene[] = [];
  private readonly file: string;
  constructor(dataDir: string) { this.file = path.join(dataDir, "scenes.json"); }
  async initialize(): Promise<void> {
    try {
      const data = JSON.parse(await readFile(this.file, "utf8"));
      const parsed = z.object({ version: z.literal(1), scenes: z.array(sceneSchema.extend({ id: z.string().min(1) })) }).parse(data);
      this.scenes = parsed.scenes;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  list(): Scene[] { return structuredClone(this.scenes); }
  async importScenes(scenes: Scene[]): Promise<void> { this.scenes = structuredClone(scenes); await saveJson(this.file, { version: 1, scenes: this.scenes }); }
  get(id: string): Scene | null { return this.list().find(scene => scene.id === id) ?? null; }
  async save(value: unknown, id?: string): Promise<Scene> {
    const scene = { ...sceneSchema.parse(value), id: id ?? randomUUID() };
    if (id && !this.get(id)) throw new Error("Cena não encontrada.");
    this.scenes = [...this.scenes.filter(item => item.id !== scene.id), scene];
    await saveJson(this.file, { version: 1, scenes: this.scenes }); return structuredClone(scene);
  }
  async delete(id: string): Promise<void> {
    if (!this.get(id)) throw new Error("Cena não encontrada.");
    this.scenes = this.scenes.filter(scene => scene.id !== id);
    await saveJson(this.file, { version: 1, scenes: this.scenes });
  }
}
