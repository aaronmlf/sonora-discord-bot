import path from "node:path";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { LibraryService } from "../library/library-service.js";
import type { PlaylistService } from "../playlists/playlist-service.js";
import type { PlayerManager } from "../player/player-manager.js";
import { SceneService, sceneSchema } from "../scenes/scene-service.js";
import type { LibraryTrack, QueuedTrack } from "../types.js";

export async function registerStudioRoutes(app: FastifyInstance, options: {
  dataDir: string; library: LibraryService; playlists: PlaylistService; players: PlayerManager;
  isOwner: (request: FastifyRequest) => boolean;
  requester: (request: FastifyRequest) => string;
  broadcast: (event: string, payload: unknown) => void;
}): Promise<SceneService> {
  const { library, playlists, players, broadcast } = options;
  const scenes = new SceneService(options.dataDir); await scenes.initialize();
  const state = async () => ({ scenes: scenes.list(), folders: await library.folders(), trash: library.listTrash(), duplicates: library.duplicates(), persistenceError: players.getPersistenceError() });
  const changed = () => { broadcast("library", library.list()); broadcast("studio", {}); };
  const queued = (track: LibraryTrack, request: FastifyRequest): QueuedTrack => ({ ...track, requestedBy: options.requester(request), requestedAt: new Date().toISOString() });
  // All routes inherit the main server's authentication and CSRF hooks.
  app.get("/api/studio", state);
  app.get("/api/library/:trackId/preview", async (request, reply) => {
    const track = library.get((request.params as { trackId: string }).trackId);
    if (!track) return reply.code(404).send({ error: "Áudio não encontrado." });
    const file = await library.assertSafeFile(track);
    return reply.sendFile(path.basename(file), path.dirname(file), { cacheControl: false });
  });
  app.post("/api/studio/library", async (request, reply) => {
    const body = z.discriminatedUnion("action", [
      z.object({ action: z.literal("folder"), folder: z.string().min(1).max(500) }),
      z.object({ action: z.literal("move"), trackId: z.string(), folder: z.string().min(1).max(500) }),
      z.object({ action: z.literal("restore"), trackId: z.string() }),
      z.object({ action: z.literal("purge") }),
    ]).safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "Operação inválida." });
    try {
      const value = body.data;
      if (value.action === "purge") {
        if (!options.isOwner(request)) return reply.code(403).send({ error: "Somente o anfitrião pode esvaziar a lixeira." });
        await library.purgeTrash(); await playlists.pruneMissingTracks(library.knownIds()); broadcast("playlists", playlists.list());
      } else if (value.action === "folder") await library.safeFolder(value.folder, true);
      else if (value.action === "move") players.updateTrack(await library.move(value.trackId, value.folder));
      else await library.restore(value.trackId);
      changed(); return state();
    } catch (error) { return reply.code(400).send({ error: (error as Error).message }); }
  });
  app.post("/api/scenes", async (request, reply) => {
    const body = z.object({ id: z.string().optional(), scene: sceneSchema }).safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "Cena inválida: confira os campos e o limite de três ambientes." });
    const scene = body.data.scene;
    if ((scene.playlistId && !playlists.get(scene.playlistId)) || scene.environments.some(item => !library.get(item.trackId)) || scene.effectIds.some(id => library.get(id)?.category !== "effect")) return reply.code(400).send({ error: "A cena contém áudios ou playlist indisponíveis." });
    try {
      const saved = await scenes.save(scene, body.data.id); broadcast("studio", {}); return { scene: saved };
    } catch (error) { return reply.code(400).send({ error: (error as Error).message }); }
  });
  app.delete("/api/scenes/:id", async (request, reply) => {
    try { await scenes.delete((request.params as { id: string }).id); broadcast("studio", {}); return { ok: true }; }
    catch (error) { return reply.code(404).send({ error: (error as Error).message }); }
  });
  const control = z.discriminatedUnion("action", [
    z.object({ action: z.literal("entry"), entryId: z.string().min(1), operation: z.enum(["play", "remove", "before"]), beforeId: z.string().optional() }),
    z.object({ action: z.literal("shuffle") }),
    z.object({ action: z.literal("saveQueue"), name: z.string().trim().min(1).max(100) }),
    z.object({ action: z.literal("restoreQueue") }),
    z.object({ action: z.literal("discardQueue") }),
    z.object({ action: z.literal("playNow"), trackId: z.string() }),
    z.object({ action: z.literal("environment"), trackId: z.string(), volume: z.number().min(0).max(100) }),
    z.object({ action: z.literal("environmentVolume"), value: z.number().min(0).max(100) }),
    z.object({ action: z.literal("ducking"), value: z.boolean() }),
    z.object({ action: z.literal("stopLayer"), playbackId: z.string() }),
    z.object({ action: z.literal("layerVolume"), playbackId: z.string(), value: z.number().min(0).max(100) }),
    z.object({ action: z.literal("stopEffects") }),
    z.object({ action: z.literal("scene"), sceneId: z.string() }),
  ]);
  app.post("/api/sessions/:guildId/studio", async (request, reply) => {
    const player = players.get((request.params as { guildId: string }).guildId);
    if (!player) return reply.code(404).send({ error: "Sessão não encontrada. Chame o bot pelo Discord." });
    const parsed = control.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Comando inválido." });
    const body = parsed.data;
    if (["restoreQueue", "playNow", "environment", "scene"].includes(body.action) && !player.getSnapshot().voiceChannelId) return reply.code(409).send({ error: "Entre em um canal e chame o bot pelo Discord primeiro." });
    try {
      switch (body.action) {
        case "entry": if (!player.entryAction(body.entryId, body.operation, body.beforeId)) return reply.code(409).send({ error: "Esse item já mudou ou saiu da fila. Tente novamente." }); break;
        case "shuffle": player.shuffle(); break;
        case "restoreQueue": player.restoreRecovery(track => {
          if (track.source !== "local") return track;
          const current = library.get(track.id); return current ? { ...track, ...current } : null;
        }); break;
        case "discardQueue": player.discardRecovery(); break;
        case "saveQueue": {
          const snapshot = player.getSnapshot();
          const tracks = [snapshot.current, ...snapshot.upcoming].filter((t): t is QueuedTrack => Boolean(t));
          if (!tracks.length) throw new Error("A fila está vazia.");
          if (tracks.some(t => t.source !== "local" || !library.get(t.id))) throw new Error("Só é possível salvar uma fila composta por áudios locais disponíveis.");
          await playlists.create(body.name, undefined, tracks.map(track => track.id));
          broadcast("playlists", playlists.list()); break;
        }
        case "playNow": {
          const track = library.get(body.trackId); if (!track) throw new Error("Áudio não encontrado.");
          const hasCurrent = Boolean(player.getSnapshot().current); player.enqueue(queued(track, request), true); if (hasCurrent) player.skip(); break;
        }
        case "environment": {
          const track = library.get(body.trackId); if (!track) throw new Error("Áudio não encontrado.");
          player.addEnvironment(track, body.volume); break;
        }
        case "environmentVolume": player.setEnvironmentVolume(body.value); break;
        case "ducking": player.setDucking(body.value); break;
        case "stopLayer": player.stopLayer(body.playbackId); break;
        case "layerVolume": player.setLayerVolume(body.playbackId, body.value); break;
        case "stopEffects": player.stopEffects(); break;
        case "scene": {
          const scene = scenes.get(body.sceneId); if (!scene) throw new Error("Cena não encontrada.");
          const playlist = scene.playlistId ? playlists.get(scene.playlistId) : null;
          if (scene.playlistId && !playlist) throw new Error("A playlist da cena foi removida.");
          const music = (playlist?.items ?? []).map(item => library.get(item.trackId));
          const environments = scene.environments.map(item => library.get(item.trackId));
          if (music.some(t => !t) || environments.some(t => !t)) throw new Error("A cena tem áudios ausentes ou na lixeira. Restaure-os ou edite a cena.");
          player.activateScene(scene, (music as LibraryTrack[]).map(track => queued(track, request)), environments as LibraryTrack[]); break;
        }
      }
      return player.getSnapshot();
    } catch (error) { return reply.code(400).send({ error: (error as Error).message }); }
  });
  return scenes;
}
