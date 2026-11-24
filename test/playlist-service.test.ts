import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { PlaylistService } from "../src/playlists/playlist-service.js";

describe("PlaylistService", () => {
  it("persiste musicas e efeitos, permite repeticoes e remove referencias apagadas", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "sonora-playlists-"));
    try {
      const service = new PlaylistService(dataDir);
      await service.initialize();
      const created = await service.create("Sessao do dragao", "Musicas e efeitos");
      await service.addItem(created.id, "music-1");
      await service.addItem(created.id, "effect-1");
      await service.addItem(created.id, "effect-1");

      let playlist = service.get(created.id);
      assert.deepEqual(playlist?.items.map(({ trackId }) => trackId), [
        "music-1",
        "effect-1",
        "effect-1",
      ]);

      await service.reorder(created.id, 2, 0);
      playlist = service.get(created.id);
      const repeatedItemId = playlist?.items[0]?.id;
      assert.ok(repeatedItemId);
      await service.removeItem(created.id, repeatedItemId);
      assert.equal(service.get(created.id)?.items.length, 2);

      const reloaded = new PlaylistService(dataDir);
      await reloaded.initialize();
      assert.equal(reloaded.get(created.id)?.description, "Musicas e efeitos");
      assert.equal(reloaded.get(created.id)?.items.length, 2);

      await reloaded.removeTrack("effect-1");
      assert.deepEqual(reloaded.get(created.id)?.items.map(({ trackId }) => trackId), ["music-1"]);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
