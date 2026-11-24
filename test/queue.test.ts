import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { TrackQueue } from "../src/core/queue.js";
import type { QueuedTrack } from "../src/types.js";

function track(id: string): QueuedTrack {
  return {
    id,
    source: "local",
    title: id,
    category: "music",
    relativePath: `music/${id}.mp3`,
    sizeBytes: 1,
    modifiedAt: new Date(0).toISOString(),
    requestedBy: "teste",
    requestedAt: new Date(0).toISOString(),
  };
}

describe("TrackQueue", () => {
  it("reproduz as faixas na ordem de entrada", () => {
    const queue = new TrackQueue();
    queue.enqueue(track("a"));
    queue.enqueue(track("b"));

    assert.equal(queue.beginNext()?.id, "a");
    assert.equal(queue.complete("finished")?.id, "b");
    assert.equal(queue.complete("finished"), null);
  });

  it("repete somente a faixa concluida no modo track", () => {
    const queue = new TrackQueue();
    queue.enqueue(track("a"));
    queue.enqueue(track("b"));
    queue.setRepeatMode("track");

    assert.equal(queue.beginNext()?.id, "a");
    assert.equal(queue.complete("finished")?.id, "a");
    assert.equal(queue.upcoming[0]?.id, "b");
  });

  it("move faixas concluidas para o fim no modo queue", () => {
    const queue = new TrackQueue();
    queue.enqueue(track("a"));
    queue.enqueue(track("b"));
    queue.setRepeatMode("queue");

    assert.equal(queue.beginNext()?.id, "a");
    assert.equal(queue.complete("finished")?.id, "b");
    assert.equal(queue.upcoming[0]?.id, "a");
  });

  it("nao repete uma faixa que falhou", () => {
    const queue = new TrackQueue();
    queue.enqueue(track("a"));
    queue.setRepeatMode("queue");

    queue.beginNext();
    assert.equal(queue.complete("failed"), null);
  });

  it("reordena e remove apenas indices validos", () => {
    const queue = new TrackQueue();
    queue.enqueue(track("a"));
    queue.enqueue(track("b"));
    queue.enqueue(track("c"));

    assert.equal(queue.reorder(2, 0), true);
    assert.deepEqual(queue.upcoming.map(({ id }) => id), ["c", "a", "b"]);
    assert.equal(queue.remove(1)?.id, "a");
    assert.equal(queue.remove(99), null);
  });

  it("seleciona uma faixa futura e descarta as anteriores", () => {
    const queue = new TrackQueue();
    queue.enqueue(track("a"));
    queue.enqueue(track("b"));
    queue.enqueue(track("c"));
    queue.enqueue(track("d"));
    queue.beginNext();

    assert.equal(queue.selectUpcoming(1)?.id, "c");
    assert.deepEqual(queue.upcoming.map(({ id }) => id), ["c", "d"]);
    assert.equal(queue.complete("skipped")?.id, "c");
    assert.equal(queue.selectUpcoming(99), null);
  });

  it("atualiza metadados e remove todas as copias de uma faixa pendente", () => {
    const queue = new TrackQueue();
    queue.enqueue(track("a"));
    queue.enqueue(track("b"));
    queue.enqueue(track("a"));

    const queued = track("b");
    assert.equal(queued.source, "local");
    if (queued.source !== "local") throw new Error("Faixa local esperada.");
    const { requestedBy: _requestedBy, requestedAt: _requestedAt, ...localTrack } = queued;
    assert.equal(queue.replaceLibraryTrack({
      ...localTrack,
      title: "Titulo atualizado",
    }), true);
    assert.equal(queue.upcoming[1]?.title, "Titulo atualizado");
    assert.equal(queue.removeByTrackId("a"), 2);
    assert.deepEqual(queue.upcoming.map(({ id }) => id), ["b"]);
  });
});
