import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import type { FastifyInstance } from "fastify";

import { AccessService } from "../src/access/access-service.js";
import type { AudioSourceFactory } from "../src/audio/audio-source-factory.js";
import type { AppConfig } from "../src/config.js";
import type { DiscordBot } from "../src/discord/discord-bot.js";
import { LibraryService } from "../src/library/library-service.js";
import { PlayerManager } from "../src/player/player-manager.js";
import { PlaylistService } from "../src/playlists/playlist-service.js";
import { createAppServer } from "../src/server/app-server.js";
import type { ExternalSourceService } from "../src/sources/external-source-service.js";

function cookieHeader(setCookie: string | string[] | undefined): string {
  const cookies = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  return cookies.map((cookie) => cookie.split(";", 1)[0]).join("; ");
}

describe("acesso remoto", () => {
  it("protege o painel, aceita convite e encerra a sessao revogada", async () => {
    const temporaryRoot = await mkdtemp(path.join(tmpdir(), "sonora-remote-"));
    const audioDir = path.join(temporaryRoot, "audio");
    const dataDir = path.join(temporaryRoot, "data");
    let app: FastifyInstance | undefined;

    try {
      await mkdir(audioDir, { recursive: true });
      const library = new LibraryService(audioDir, dataDir);
      await library.initialize();
      const playlists = new PlaylistService(dataDir);
      await playlists.initialize();
      const access = new AccessService(dataDir);
      await access.initialize();
      const players = new PlayerManager({
        audioSources: {} as AudioSourceFactory,
        defaultVolume: 70,
        defaultEffectVolume: 100,
        idleTimeoutMs: 0,
      });
      const bot = Object.assign(new EventEmitter(), {
        getStatus: () => ({ configured: false, connected: false, username: null }),
      }) as unknown as DiscordBot;
      const config: AppConfig = {
        host: "127.0.0.1",
        port: 3210,
        adminToken: "a".repeat(32),
        remoteAccessEnabled: true,
        publicUrl: "https://sonora.example.ts.net",
        audioDir,
        dataDir,
        ytDlpPath: "yt-dlp",
        defaultVolume: 70,
        defaultEffectVolume: 100,
        idleTimeoutMs: 0,
        maxUploadBytes: 10 * 1024 * 1024,
        logLevel: "silent",
      };
      app = await createAppServer({
        config,
        access,
        library,
        playlists,
        players,
        bot,
        externalSources: {} as ExternalSourceService,
      });

      assert.equal((await app.inject({ url: "/api/state" })).statusCode, 401);
      for (const url of ["/api/studio", "/api/library/example/preview"]) assert.equal((await app.inject({ url })).statusCode, 401);
      const login = await app.inject({
        method: "POST",
        url: "/api/auth/owner",
        payload: { token: config.adminToken },
      });
      assert.equal(login.statusCode, 200);
      const ownerCookie = cookieHeader(login.headers["set-cookie"]);
      const ownerCsrf = login.json().access.csrfToken as string;

      const blocked = await app.inject({
        method: "POST",
        url: "/api/access/invitations",
        headers: { cookie: ownerCookie },
        payload: { displayName: "Volt" },
      });
      assert.equal(blocked.statusCode, 403);

      const created = await app.inject({
        method: "POST",
        url: "/api/access/invitations",
        headers: { cookie: ownerCookie, "x-csrf-token": ownerCsrf },
        payload: { displayName: "Volt" },
      });
      assert.equal(created.statusCode, 201);
      const invitationUrl = new URL(created.json().invitation.url as string);
      const invitationToken = invitationUrl.pathname.split("/").at(-1);
      assert.ok(invitationToken);

      const preview = await app.inject({ url: `/api/auth/invitations/${invitationToken}` });
      assert.equal(preview.statusCode, 200);
      assert.equal(preview.json().displayName, "Volt");

      const redeemed = await app.inject({
        method: "POST",
        url: `/api/auth/invitations/${invitationToken}/redeem`,
      });
      assert.equal(redeemed.statusCode, 200);
      const collaboratorCookie = cookieHeader(redeemed.headers["set-cookie"]);
      const collaboratorCsrf = redeemed.json().access.csrfToken as string;
      players.getOrCreate("111", "Permitido"); players.getOrCreate("222", "Privado");
      const policyId = created.json().invitation.collaboratorId as string;
      await access.updatePolicy(policyId, { profile: "effects", guildIds: ["111"] });
      const scoped = await app.inject({ url: "/api/state", headers: { cookie: collaboratorCookie } });
      assert.deepEqual(scoped.json().sessions.map((session: { guildId: string }) => session.guildId), ["111"]);
      assert.equal((await app.inject({ method: "POST", url: "/api/sessions/222/actions", headers: { cookie: collaboratorCookie, "x-csrf-token": collaboratorCsrf }, payload: { action: "effectVolume", value: 50 } })).statusCode, 403);
      assert.equal((await app.inject({ method: "POST", url: "/api/sessions/111/actions", headers: { cookie: collaboratorCookie, "x-csrf-token": collaboratorCsrf }, payload: { action: "volume", value: 50 } })).statusCode, 403);
      assert.equal((await app.inject({ method: "POST", url: "/api/sessions/111/actions", headers: { cookie: collaboratorCookie, "x-csrf-token": collaboratorCsrf }, payload: { action: "effectVolume", value: 50 } })).statusCode, 200);
      assert.equal((await app.inject({ method: "POST", url: "/api/backups/export", headers: { cookie: collaboratorCookie, "x-csrf-token": collaboratorCsrf }, payload: {} })).statusCode, 403);
      const scopedEvents = app.inject({ url: "/api/events", headers: { cookie: collaboratorCookie } });
      await new Promise(resolve => setTimeout(resolve, 20));
      players.get("111")!.setEffectVolume(60); players.get("222")!.setEffectVolume(90);
      await app.inject({ method: "PATCH", url: `/api/access/collaborators/${policyId}`, headers: { cookie: ownerCookie, "x-csrf-token": ownerCsrf }, payload: { profile: "full", guildIds: null } });
      const eventResponse = await scopedEvents;
      assert.ok(eventResponse.body.includes("session-ended"));
      assert.equal(eventResponse.body.includes('"guildId":"222"'), false, "SSE must not leak unauthorized guilds");
      assert.equal((await app.inject({ method: "POST", url: "/api/studio/library", headers: { cookie: collaboratorCookie }, payload: { action: "folder", folder: "music/Test" } })).statusCode, 403);
      assert.equal((await app.inject({ method: "POST", url: "/api/studio/library", headers: { cookie: collaboratorCookie, "x-csrf-token": collaboratorCsrf }, payload: { action: "folder", folder: "music/Test" } })).statusCode, 200);
      assert.equal((await app.inject({ method: "POST", url: "/api/studio/library", headers: { cookie: collaboratorCookie, "x-csrf-token": collaboratorCsrf }, payload: { action: "purge" } })).statusCode, 403);
      assert.equal((await app.inject({
        url: "/api/state",
        headers: { cookie: collaboratorCookie },
      })).statusCode, 200);
      assert.equal((await app.inject({
        url: "/api/access",
        headers: { cookie: collaboratorCookie },
      })).statusCode, 403);

      const collaboratorId = created.json().invitation.collaboratorId as string;
      const openEvents = app.inject({ url: "/api/events", headers: { cookie: collaboratorCookie } });
      await new Promise(resolve => setTimeout(resolve, 20));
      const revoked = await app.inject({
        method: "DELETE",
        url: `/api/access/collaborators/${collaboratorId}`,
        headers: { cookie: ownerCookie, "x-csrf-token": ownerCsrf },
      });
      assert.equal(revoked.statusCode, 200);
      assert.ok((await openEvents).body.includes("session-ended"), "Revocation must end an already-open SSE stream");
      assert.equal((await app.inject({
        url: "/api/state",
        headers: { cookie: collaboratorCookie },
      })).statusCode, 401);
    } finally {
      if (app) await app.close();
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });
});
