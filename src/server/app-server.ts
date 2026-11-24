import { timingSafeEqual } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createWriteStream } from "node:fs";
import { rm, rename } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import path from "node:path";
import { pipeline } from "node:stream/promises";

import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { z } from "zod";

import { AccessService, type AuthenticatedAccess, type IssuedSession } from "../access/access-service.js";
import type { AppConfig } from "../config.js";
import type { DiscordBot } from "../discord/discord-bot.js";
import { LibraryService } from "../library/library-service.js";
import { PlayerManager } from "../player/player-manager.js";
import { PlaylistService } from "../playlists/playlist-service.js";
import { ExternalSourceService } from "../sources/external-source-service.js";
import { registerStudioRoutes } from "./studio-routes.js";
import { canRequest, canSeeGuild } from "../access/policy.js";
import { randomUUID } from "node:crypto";
import { BackupService } from "../backup/backup-service.js";
import {
  AUDIO_CATEGORIES,
  REPEAT_MODES,
  type AccessPrincipal,
  type AccessStatus,
  type AppSnapshot,
  type LibraryTrack,
} from "../types.js";

interface ServerDependencies {
  config: AppConfig;
  access: AccessService;
  library: LibraryService;
  playlists: PlaylistService;
  externalSources: ExternalSourceService;
  players: PlayerManager;
  bot: DiscordBot;
}

export type AppServer = FastifyInstance & {
  scanLibrary(): Promise<LibraryTrack[]>;
};

const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("pause") }),
  z.object({ action: z.literal("resume") }),
  z.object({ action: z.literal("skip") }),
  z.object({ action: z.literal("stop") }),
  z.object({ action: z.literal("leave") }),
  z.object({ action: z.literal("clear") }),
  z.object({ action: z.literal("volume"), value: z.number().min(0).max(100) }),
  z.object({ action: z.literal("effectVolume"), value: z.number().min(0).max(150) }),
  z.object({ action: z.literal("loop"), value: z.enum(REPEAT_MODES) }),
]);

const enqueueSchema = z.object({
  trackId: z.string().min(1),
  position: z.enum(["end", "next"]).default("end"),
});

const batchEnqueueSchema = z.object({
  trackIds: z.array(z.string().min(1)).min(1).max(1_000),
  shuffle: z.boolean().default(false),
});

const reorderSchema = z.object({
  from: z.number().int().nonnegative(),
  to: z.number().int().nonnegative(),
});

const externalEnqueueSchema = z.object({
  url: z.string().url().max(2_048),
  position: z.enum(["end", "next"]).default("end"),
});

const effectSchema = z.object({ trackId: z.string().min(1) });

const trackUpdateSchema = z
  .object({
    favorite: z.boolean().optional(),
    tags: z.array(z.string().trim().min(1).max(40)).max(30).optional(),
    title: z.string().trim().min(1).max(180).optional(),
    artist: z.string().trim().max(180).nullable().optional(),
    album: z.string().trim().max(180).nullable().optional(),
    category: z.enum(AUDIO_CATEGORIES).optional(),
  })
  .refine((value) => Object.values(value).some((item) => item !== undefined));

const playlistDetailsSchema = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(400).nullable().optional(),
});

const playlistCreateSchema = playlistDetailsSchema.extend({ trackId: z.string().min(1).optional() });
const playlistUpdateSchema = playlistDetailsSchema
  .partial()
  .refine((value) => Object.values(value).some((item) => item !== undefined));

const playlistItemSchema = z.object({ trackId: z.string().min(1) });
const ownerLoginSchema = z.object({ token: z.string().min(1).max(1_024) });
const invitationCreateSchema = z.object({
  displayName: z.string().trim().min(1).max(80),
  profile: z.enum(["full", "playback", "effects"]).default("full"),
  guildIds: z.array(z.string().min(1).max(30)).max(100).nullable().default(null),
});

const SESSION_COOKIE = "sonora_session";
const CSRF_COOKIE = "sonora_csrf";

interface RequestActor {
  principal: AccessPrincipal;
  access: AuthenticatedAccess | null;
  sessionToken: string | null;
  viaBearer: boolean;
}

function tokenMatches(expected: string, received: string): boolean {
  const expectedBuffer = Buffer.from(expected);
  const receivedBuffer = Buffer.from(received);
  return (
    expectedBuffer.length === receivedBuffer.length &&
    timingSafeEqual(expectedBuffer, receivedBuffer)
  );
}

function receivedToken(request: FastifyRequest): string | undefined {
  const authorization = request.headers.authorization;
  if (authorization?.startsWith("Bearer ")) return authorization.slice(7);
  return undefined;
}

function parseCookies(request: FastifyRequest): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const part of request.headers.cookie?.split(";") ?? []) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    try {
      cookies[name] = decodeURIComponent(value);
    } catch {
      cookies[name] = value;
    }
  }
  return cookies;
}

function isSecureRequest(request: FastifyRequest): boolean {
  const forwarded = request.headers["x-forwarded-proto"];
  return request.protocol === "https" || forwarded === "https";
}

function serializeCookie(
  name: string,
  value: string,
  options: { httpOnly: boolean; secure: boolean; maxAge: number },
): string {
  return [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    `Max-Age=${Math.max(0, Math.floor(options.maxAge))}`,
    "SameSite=Strict",
    options.httpOnly ? "HttpOnly" : "",
    options.secure ? "Secure" : "",
  ].filter(Boolean).join("; ");
}

function setSessionCookies(
  request: FastifyRequest,
  reply: { header(name: string, value: string | string[]): unknown },
  session: IssuedSession,
): void {
  const maxAge = session.expiresAt
    ? Math.max(1, Math.floor((Date.parse(session.expiresAt) - Date.now()) / 1_000))
    : 365 * 24 * 60 * 60;
  const secure = isSecureRequest(request);
  reply.header("Set-Cookie", [
    serializeCookie(SESSION_COOKIE, session.sessionToken, {
      httpOnly: true,
      secure,
      maxAge,
    }),
    serializeCookie(CSRF_COOKIE, session.csrfToken, {
      httpOnly: false,
      secure,
      maxAge,
    }),
  ]);
}

function clearSessionCookies(
  request: FastifyRequest,
  reply: { header(name: string, value: string | string[]): unknown },
): void {
  const secure = isSecureRequest(request);
  reply.header("Set-Cookie", [
    serializeCookie(SESSION_COOKIE, "", { httpOnly: true, secure, maxAge: 0 }),
    serializeCookie(CSRF_COOKIE, "", { httpOnly: false, secure, maxAge: 0 }),
  ]);
}

export async function createAppServer(
  dependencies: ServerDependencies,
): Promise<AppServer> {
  const { config, access, library, playlists, externalSources, players, bot } = dependencies;
  const app = Fastify({
    logger: { level: config.logLevel },
    trustProxy: ["127.0.0.1", "::1"],
  });
  const eventClients = new Map<ServerResponse, RequestActor>();
  const recentActions: Array<{ id: string; actor: string; action: string; guildId: string | null; at: string }> = [];
  let maintenance = false;
  const lastSessionErrors = new Map<string, string>();
  const requestActors = new WeakMap<FastifyRequest, RequestActor>();
  const authAttempts = new Map<string, { count: number; resetAt: number }>();

  const snapshot = (principal: AccessPrincipal): AppSnapshot => ({
    bot: bot.getStatus(),
    library: library.list(),
    playlists: playlists.list(),
    sessions: players.list().filter(session => canSeeGuild(principal, session.guildId)),
  });

  const endClient = (client: ServerResponse): void => {
    client.write(`event: session-ended\ndata: {}\n\n`); client.end(); eventClients.delete(client);
  };
  const currentPrincipal = (actor: RequestActor): AccessPrincipal | null => actor.sessionToken ? access.authenticate(actor.sessionToken)?.principal ?? null : actor.principal;

  const broadcast = (event: string, payload: unknown): void => {
    const message = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const [client, actor] of eventClients) {
      const principal = currentPrincipal(actor);
      if (!principal) { endClient(client); continue; }
      if (event === "session" && !canSeeGuild(principal, (payload as { guildId: string }).guildId)) continue;
      if (event === "activity") { const item = payload as { guildId: string | null }; if (principal.role !== "owner" && (!item.guildId || !canSeeGuild(principal, item.guildId))) continue; }
      if (event === "state") { client.write(`event: state\ndata: ${JSON.stringify(snapshot(principal))}\n\n`); continue; }
      client.write(message);
    }
  };
  const expirationTimer = setInterval(() => {
    for (const [client, actor] of eventClients) if (!currentPrincipal(actor)) endClient(client);
  }, 1000);
  expirationTimer.unref();

  const actorFor = (request: FastifyRequest): RequestActor => {
    const actor = requestActors.get(request);
    if (!actor) throw new Error("Contexto de acesso indisponivel.");
    return actor;
  };

  const requesterLabel = (request: FastifyRequest): string => {
    const principal = actorFor(request).principal;
    return principal.role === "owner"
      ? "Painel do anfitriao"
      : `Painel · ${principal.displayName}`;
  };

  const accessStatus = (request: FastifyRequest): AccessStatus => {
    const actor = actorFor(request);
    const cookies = parseCookies(request);
    return {
      authenticated: true,
      principal: actor.principal,
      csrfToken: actor.access && cookies[CSRF_COOKIE]
        ? cookies[CSRF_COOKIE]
        : null,
      remoteAccessEnabled: config.remoteAccessEnabled,
      publicUrl: config.publicUrl ?? null,
    };
  };

  const authRateLimited = (request: FastifyRequest): boolean => {
    const key = request.ip;
    const now = Date.now();
    if (authAttempts.size > 1_000) {
      for (const [address, attempt] of authAttempts) {
        if (attempt.resetAt <= now) authAttempts.delete(address);
      }
    }
    const current = authAttempts.get(key);
    if (!current || current.resetAt <= now) {
      authAttempts.set(key, { count: 1, resetAt: now + 60_000 });
      return false;
    }
    current.count += 1;
    return current.count > 8;
  };

  const isPublicApiPath = (url: string): boolean => {
    const pathname = url.split("?", 1)[0] ?? url;
    return pathname === "/api/health" ||
      pathname === "/api/auth/owner" ||
      /^\/api\/auth\/invitations\/[^/]+(?:\/redeem)?$/.test(pathname);
  };

  players.on("update", (session) => {
    if (session.error && lastSessionErrors.get(session.guildId) !== session.error) {
      lastSessionErrors.set(session.guildId, session.error);
      app.log.error(
        { guildId: session.guildId, error: session.error },
        "Falha ao reproduzir audio",
      );
    } else if (!session.error) {
      lastSessionErrors.delete(session.guildId);
    }
    broadcast("session", session);
  });
  bot.on("status", (status) => broadcast("bot", status));
  players.on("persistenceError", () => {
    app.log.error("Não foi possível salvar a recuperação da fila. Verifique a pasta de dados.");
    broadcast("studio", {});
  });

  app.addHook("onRequest", async (request, reply) => {
    if (!request.url.startsWith("/api/")) return;
    if (isPublicApiPath(request.url)) return;

    if (!config.adminToken && !config.remoteAccessEnabled) {
      requestActors.set(request, {
        principal: { role: "owner", displayName: "Anfitrião" },
        access: null,
        sessionToken: null,
        viaBearer: false,
      });
      return;
    }

    const bearer = receivedToken(request);
    if (bearer && config.adminToken && tokenMatches(config.adminToken, bearer)) {
      requestActors.set(request, {
        principal: { role: "owner", displayName: "Anfitrião" },
        access: null,
        sessionToken: null,
        viaBearer: true,
      });
      return;
    }

    const cookies = parseCookies(request);
    const sessionToken = cookies[SESSION_COOKIE];
    const authenticated = sessionToken ? access.authenticate(sessionToken) : null;
    if (!authenticated) {
      return reply.code(401).send({ error: "Acesso nao autenticado." });
    }
    requestActors.set(request, {
      principal: authenticated.principal,
      access: authenticated,
      sessionToken: sessionToken ?? null,
      viaBearer: false,
    });

    if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) {
      const csrfToken = request.headers["x-csrf-token"];
      if (typeof csrfToken !== "string" || !access.verifyCsrf(authenticated, csrfToken)) {
        return reply.code(403).send({ error: "Protecao da sessao invalida." });
      }
    }
  });

  app.addHook("onSend", async (request, reply, payload) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    reply.header(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    );
    if (isSecureRequest(request)) {
      reply.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    }
    if (request.url.startsWith("/api/") || request.url.startsWith("/invite/")) {
      reply.header("Cache-Control", "no-store");
    }
    return payload;
  });

  app.addHook("preHandler", async (request, reply) => {
    if (!request.url.startsWith("/api/") || isPublicApiPath(request.url)) return;
    const actor = actorFor(request);
    const principal = currentPrincipal(actor);
    if (!principal) return reply.code(401).send({ error: "Sessão encerrada." });
    actor.principal = principal;
    const pathname = decodeURIComponent(request.url.split("?")[0]!);
    if (maintenance && !["GET", "HEAD"].includes(request.method) && !pathname.startsWith("/api/auth/")) return reply.code(503).send({ error: "Backup/restauração em andamento. Tente novamente ao concluir." });
    if (!canRequest(principal, request.method, pathname, request.body)) return reply.code(403).send({ error: "Seu perfil não permite esta ação ou este servidor." });
    if (principal.profile === "effects" && (request.body as { action?: string })?.action === "stopLayer") {
      const guildId = (request.params as { guildId?: string }).guildId;
      const id = (request.body as { playbackId?: string }).playbackId;
      if (!guildId || !players.get(guildId)?.getSnapshot().activeEffects.some(effect => effect.playbackId === id)) return reply.code(403).send({ error: "Seu perfil permite parar apenas efeitos." });
    }
  });

  app.addHook("onResponse", async (request, reply) => {
    if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return;
    const actor = requestActors.get(request)?.principal;
    if (!actor) return;
    if (reply.statusCode < 400 && /^\/api\/(sessions|library|scenes)\//.test(request.url.split("?")[0]!) && !request.url.includes("/preview")) {
      const body = request.body as { action?: string } | undefined;
      const names: Record<string, string> = { volume: "Alterou volume musical", effectVolume: "Alterou volume dos efeitos", environmentVolume: "Alterou volume dos ambientes", scene: "Trocou cena", pause: "Pausou música", resume: "Retomou música", skip: "Pulou faixa", stop: "Parou áudio", shuffle: "Embaralhou fila", playNow: "Escolheu música", environment: "Adicionou ambiente", stopEffects: "Parou efeitos" };
      const item = { id: randomUUID(), actor: actor.displayName, action: names[body?.action ?? ""] ?? (request.url.includes("/queue") ? "Alterou a fila" : request.url.includes("/effects") ? "Disparou efeito" : request.url.includes("/library") ? (request.method === "DELETE" ? "Moveu áudio para lixeira" : "Alterou biblioteca") : "Alterou áudio/cena"), guildId: (request.params as { guildId?: string }).guildId ?? null, at: new Date().toISOString() };
      recentActions.unshift(item); recentActions.splice(100); broadcast("activity", item);
    }
    app.log.info(
      {
        actorRole: actor.role,
        actorName: actor.displayName,
        collaboratorId: actor.collaboratorId,
        method: request.method,
        url: request.url.split("?", 1)[0],
        statusCode: reply.statusCode,
      },
      "Acao no painel",
    );
  });

  await app.register(multipart, {
    limits: { files: 1, fileSize: config.maxUploadBytes },
  });
  await app.register(fastifyStatic, {
    root: path.resolve("public"),
    prefix: "/",
    wildcard: false,
  });

  app.get("/api/health", async () => ({ status: "ok" }));
  app.post("/api/auth/owner", async (request, reply) => {
    if (authRateLimited(request)) {
      return reply.code(429).send({ error: "Muitas tentativas. Aguarde um minuto." });
    }
    const body = ownerLoginSchema.safeParse(request.body);
    if (!body.success || !config.adminToken || !tokenMatches(config.adminToken, body.data.token)) {
      return reply.code(401).send({ error: "Token administrativo invalido." });
    }
    const session = access.issueOwnerSession();
    setSessionCookies(request, reply, session);
    return {
      access: {
        authenticated: true,
        principal: session.principal,
        csrfToken: session.csrfToken,
        remoteAccessEnabled: config.remoteAccessEnabled,
        publicUrl: config.publicUrl ?? null,
      } satisfies AccessStatus,
    };
  });

  app.get("/api/auth/invitations/:token", async (request, reply) => {
    const { token } = request.params as { token: string };
    const preview = access.previewInvitation(token);
    if (!preview) return reply.code(404).send({ error: "Convite invalido, usado ou expirado." });
    return preview;
  });

  app.post("/api/auth/invitations/:token/redeem", async (request, reply) => {
    if (authRateLimited(request)) {
      return reply.code(429).send({ error: "Muitas tentativas. Aguarde um minuto." });
    }
    const { token } = request.params as { token: string };
    try {
      const session = await access.redeemInvitation(token);
      setSessionCookies(request, reply, session);
      return {
        access: {
          authenticated: true,
          principal: session.principal,
          csrfToken: session.csrfToken,
          remoteAccessEnabled: config.remoteAccessEnabled,
          publicUrl: config.publicUrl ?? null,
        } satisfies AccessStatus,
      };
    } catch (error) {
      return reply.code(410).send({ error: (error as Error).message });
    }
  });

  app.get("/api/auth/session", async (request) => ({ access: accessStatus(request) }));

  app.post("/api/auth/logout", async (request, reply) => {
    const actor = actorFor(request);
    if (actor.sessionToken) await access.revokeSession(actor.sessionToken);
    for (const [client, connected] of eventClients) if (actor.sessionToken && connected.sessionToken === actor.sessionToken) endClient(client);
    clearSessionCookies(request, reply);
    return { ok: true };
  });

  app.get("/api/access", async (request, reply) => {
    if (actorFor(request).principal.role !== "owner") {
      return reply.code(403).send({ error: "Somente o anfitriao gerencia acessos." });
    }
    return {
      remoteAccessEnabled: config.remoteAccessEnabled,
      publicUrl: config.publicUrl ?? null,
      collaborators: access.listCollaborators(),
      invitations: access.listInvitations(),
    };
  });

  app.post("/api/access/invitations", async (request, reply) => {
    if (actorFor(request).principal.role !== "owner") {
      return reply.code(403).send({ error: "Somente o anfitriao gerencia acessos." });
    }
    if (!config.remoteAccessEnabled || !config.publicUrl) {
      return reply.code(409).send({ error: "Ative e configure o acesso remoto primeiro." });
    }
    const body = invitationCreateSchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "Nome do convidado invalido." });
    const invitation = await access.createInvitation(body.data.displayName, { profile: body.data.profile, guildIds: body.data.guildIds });
    return reply.code(201).send({
      invitation: {
        id: invitation.id,
        collaboratorId: invitation.collaboratorId,
        displayName: invitation.displayName,
        expiresAt: invitation.expiresAt,
        url: `${config.publicUrl}/invite/${invitation.token}`,
      },
      collaborators: access.listCollaborators(),
      invitations: access.listInvitations(),
    });
  });

  app.delete("/api/access/invitations/:invitationId", async (request, reply) => {
    if (actorFor(request).principal.role !== "owner") {
      return reply.code(403).send({ error: "Somente o anfitriao gerencia acessos." });
    }
    const { invitationId } = request.params as { invitationId: string };
    try {
      await access.revokeInvitation(invitationId);
      return {
        collaborators: access.listCollaborators(),
        invitations: access.listInvitations(),
      };
    } catch (error) {
      return reply.code(404).send({ error: (error as Error).message });
    }
  });

  app.delete("/api/access/collaborators/:collaboratorId", async (request, reply) => {
    if (actorFor(request).principal.role !== "owner") {
      return reply.code(403).send({ error: "Somente o anfitriao gerencia acessos." });
    }
    const { collaboratorId } = request.params as { collaboratorId: string };
    try {
      await access.revokeCollaborator(collaboratorId);
      for (const [client, actor] of eventClients) {
        if (actor.principal.collaboratorId === collaboratorId) {
          endClient(client);
        }
      }
      return {
        collaborators: access.listCollaborators(),
        invitations: access.listInvitations(),
      };
    } catch (error) {
      return reply.code(404).send({ error: (error as Error).message });
    }
  });

  app.patch("/api/access/collaborators/:collaboratorId", async (request, reply) => {
    if (actorFor(request).principal.role !== "owner") return reply.code(403).send({ error: "Somente o anfitrião gerencia acessos." });
    const body = invitationCreateSchema.omit({ displayName: true }).safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "Permissões inválidas." });
    const { collaboratorId } = request.params as { collaboratorId: string };
    try { await access.updatePolicy(collaboratorId, body.data); }
    catch (error) { return reply.code(404).send({ error: (error as Error).message }); }
    for (const [client, actor] of eventClients) if (actor.principal.collaboratorId === collaboratorId) endClient(client);
    return { collaborators: access.listCollaborators(), invitations: access.listInvitations() };
  });
  app.get("/api/activity", async request => ({ actions: recentActions.filter(item => actorFor(request).principal.role === "owner" || (item.guildId && canSeeGuild(actorFor(request).principal, item.guildId))) }));
  app.get("/api/state", async request => snapshot(actorFor(request).principal));

  app.get("/api/library/status", async () => library.getScanStatus());

  app.get("/api/diagnostics", async (request, reply) => {
    if (actorFor(request).principal.role !== "owner") {
      return reply.code(403).send({ error: "Somente o anfitrião pode executar diagnósticos." });
    }
    const checks = await Promise.all([
      ["FFmpeg", "ffmpeg", "-version"],
      ["FFprobe", "ffprobe", "-version"],
      ["yt-dlp", config.ytDlpPath, "--version"],
    ].map(async ([name, executable, argument]) => {
      try {
        await promisify(execFile)(executable!, [argument!], { timeout: 5_000, maxBuffer: 64 * 1024 });
        return { name, available: true };
      } catch { return { name, available: false }; }
    }));
    let discordReachable = false;
    try {
      const response = await fetch("https://discord.com/api/v10/gateway", { signal: AbortSignal.timeout(8_000) });
      discordReachable = response.ok;
      await response.body?.cancel();
    } catch { /* Report as unreachable without leaking network credentials. */ }
    return { checks, discordReachable, bot: bot.getStatus(), scan: library.getScanStatus() };
  });

  app.get("/api/events", async (request, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    reply.raw.write(`event: state\ndata: ${JSON.stringify(snapshot(actorFor(request).principal))}\n\n`);
    eventClients.set(reply.raw, actorFor(request));
    const heartbeat = setInterval(() => reply.raw.write(": heartbeat\n\n"), 20_000);
    heartbeat.unref();
    request.raw.on("close", () => {
      clearInterval(heartbeat);
      eventClients.delete(reply.raw);
    });
  });

  const scanLibrary = async (afterUpload = false): Promise<LibraryTrack[]> => {
    const previousTracks = new Map(library.list().map(track => [track.id, JSON.stringify(track)]));
    const tracks = await (afterUpload ? library.scanAfterUpload() : library.scan());
    const currentTrackIds = new Set(tracks.map(({ id }) => id));
    for (const trackId of previousTracks.keys()) {
      if (!currentTrackIds.has(trackId)) players.removeTrack(trackId);
    }
    // Queued entries hold track snapshots. A moved file can keep its ID, so
    // refresh changed paths too, including the current item used by repeat.
    for (const track of tracks) {
      if (previousTracks.get(track.id) !== JSON.stringify(track)) players.updateTrack(track);
    }
    const removedPlaylistItems = await playlists.pruneMissingTracks(library.knownIds());
    broadcast("library", tracks);
    broadcast("studio", {});
    if (removedPlaylistItems > 0) broadcast("playlists", playlists.list());
    return tracks;
  };
  app.decorate("scanLibrary", () => scanLibrary());
  app.post("/api/library/scan", async () => ({ tracks: await scanLibrary() }));

  app.post("/api/library/upload", async (request, reply) => {
    const categoryResult = z
      .enum(AUDIO_CATEGORIES)
      .safeParse((request.query as { category?: unknown }).category ?? "music");
    if (!categoryResult.success) {
      return reply.code(400).send({ error: "Categoria de audio invalida." });
    }

    const upload = await request.file();
    if (!upload) return reply.code(400).send({ error: "Nenhum arquivo foi enviado." });

    let destination: string;
    try {
      const subfolder = z.string().max(500).parse((request.query as { folder?: unknown }).folder ?? "");
      await library.safeFolder(`${categoryResult.data === "effect" ? "effects" : "music"}${subfolder ? `/${subfolder}` : ""}`);
      destination = library.makeUploadDestination(upload.filename, categoryResult.data, subfolder);
    } catch (error) {
      upload.file.resume();
      return reply.code(415).send({ error: (error as Error).message });
    }

    const temporaryUpload = path.join(path.dirname(destination), `.${path.basename(destination)}`);
    try {
      await pipeline(upload.file, createWriteStream(temporaryUpload, { flags: "wx" }));
      if (upload.file.truncated) {
        await rm(temporaryUpload, { force: true });
        return reply.code(413).send({ error: "O arquivo ultrapassa o limite configurado." });
      }
      await library.validateFile(temporaryUpload);
      await rename(temporaryUpload, destination);
      const tracks = await scanLibrary(true);
      return reply.code(201).send({ tracks });
    } catch (error) {
      await rm(temporaryUpload, { force: true });
      return reply.code(415).send({ error: (error as Error).message });
    }
  });

  app.patch("/api/library/:trackId", async (request, reply) => {
    const { trackId } = request.params as { trackId: string };
    const body = trackUpdateSchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "Dados do audio invalidos." });
    }
    try {
      const track = await library.update(trackId, body.data);
      players.updateTrack(track);
      const tracks = library.list();
      broadcast("library", tracks);
      return { track, tracks };
    } catch (error) {
      return reply.code(404).send({ error: (error as Error).message });
    }
  });

  app.delete("/api/library/:trackId", async (request, reply) => {
    const { trackId } = request.params as { trackId: string };
    if (!library.get(trackId)) {
      return reply.code(404).send({ error: "Audio nao encontrado." });
    }
    try {
      await library.delete(trackId);
      players.removeTrack(trackId);
      // Retain playlist references so restoration also restores membership.
      const tracks = library.list();
      const nextPlaylists = playlists.list();
      broadcast("library", tracks);
      broadcast("playlists", nextPlaylists);
      return { deletedTrackId: trackId, tracks, playlists: nextPlaylists };
    } catch (error) {
      return reply.code(500).send({ error: (error as Error).message });
    }
  });

  app.get("/api/playlists", async () => ({ playlists: playlists.list() }));

  app.post("/api/playlists", async (request, reply) => {
    const body = playlistCreateSchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "Dados da playlist invalidos." });
    }
    const { name, description, trackId } = body.data;
    if (trackId && !library.get(trackId)) return reply.code(404).send({ error: "Áudio não encontrado." });
    const playlist = await playlists.create(name, description, trackId ? [trackId] : []);
    const allPlaylists = playlists.list();
    broadcast("playlists", allPlaylists);
    return reply.code(201).send({ playlist, playlists: allPlaylists });
  });

  app.patch("/api/playlists/:playlistId", async (request, reply) => {
    const { playlistId } = request.params as { playlistId: string };
    const body = playlistUpdateSchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "Dados da playlist invalidos." });
    }
    try {
      const playlist = await playlists.update(playlistId, body.data);
      const allPlaylists = playlists.list();
      broadcast("playlists", allPlaylists);
      return { playlist, playlists: allPlaylists };
    } catch (error) {
      return reply.code(404).send({ error: (error as Error).message });
    }
  });

  app.delete("/api/playlists/:playlistId", async (request, reply) => {
    const { playlistId } = request.params as { playlistId: string };
    try {
      await playlists.delete(playlistId);
      const allPlaylists = playlists.list();
      broadcast("playlists", allPlaylists);
      return { deletedPlaylistId: playlistId, playlists: allPlaylists };
    } catch (error) {
      return reply.code(404).send({ error: (error as Error).message });
    }
  });

  app.post("/api/playlists/:playlistId/items", async (request, reply) => {
    const { playlistId } = request.params as { playlistId: string };
    const body = playlistItemSchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "Audio invalido." });
    if (!library.get(body.data.trackId)) {
      return reply.code(404).send({ error: "Audio nao encontrado." });
    }
    try {
      const playlist = await playlists.addItem(playlistId, body.data.trackId);
      const allPlaylists = playlists.list();
      broadcast("playlists", allPlaylists);
      return reply.code(201).send({ playlist, playlists: allPlaylists });
    } catch (error) {
      return reply.code(404).send({ error: (error as Error).message });
    }
  });

  app.delete("/api/playlists/:playlistId/items/:itemId", async (request, reply) => {
    const { playlistId, itemId } = request.params as {
      playlistId: string;
      itemId: string;
    };
    try {
      const playlist = await playlists.removeItem(playlistId, itemId);
      const allPlaylists = playlists.list();
      broadcast("playlists", allPlaylists);
      return { playlist, playlists: allPlaylists };
    } catch (error) {
      return reply.code(404).send({ error: (error as Error).message });
    }
  });

  app.patch("/api/playlists/:playlistId/items", async (request, reply) => {
    const { playlistId } = request.params as { playlistId: string };
    const body = reorderSchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "Reordenacao invalida." });
    try {
      const playlist = await playlists.reorder(playlistId, body.data.from, body.data.to);
      const allPlaylists = playlists.list();
      broadcast("playlists", allPlaylists);
      return { playlist, playlists: allPlaylists };
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  app.post("/api/sessions/:guildId/playlists/:playlistId", async (request, reply) => {
    const { guildId, playlistId } = request.params as {
      guildId: string;
      playlistId: string;
    };
    const player = players.get(guildId);
    if (!player) return reply.code(404).send({ error: "Sessao nao encontrada." });
    if (!player.getSnapshot().voiceChannelId) {
      return reply.code(409).send({ error: "Chame o bot para um canal pelo Discord primeiro." });
    }
    const playlist = playlists.get(playlistId);
    if (!playlist) return reply.code(404).send({ error: "Playlist nao encontrada." });
    const tracks = playlist.items
      .map(({ trackId }) => library.get(trackId))
      .filter((track): track is NonNullable<typeof track> => Boolean(track));
    if (!tracks.length) {
      return reply.code(409).send({ error: "A playlist nao possui audios disponiveis." });
    }
    const requestedAt = new Date().toISOString();
    const requestedBy = requesterLabel(request);
    player.enqueueMany(tracks.map(track => ({ ...track, requestedBy, requestedAt })));
    return { added: tracks.length, session: player.getSnapshot() };
  });

  app.post("/api/sessions/:guildId/queue", async (request, reply) => {
    const { guildId } = request.params as { guildId: string };
    const body = enqueueSchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "Pedido de fila invalido." });
    const player = players.get(guildId);
    if (!player) return reply.code(404).send({ error: "Sessao nao encontrada." });
    if (!player.getSnapshot().voiceChannelId) {
      return reply.code(409).send({ error: "Chame o bot para um canal pelo Discord primeiro." });
    }
    const track = library.get(body.data.trackId);
    if (!track) return reply.code(404).send({ error: "Audio nao encontrado." });

    player.enqueue(
      {
        ...track,
        requestedBy: requesterLabel(request),
        requestedAt: new Date().toISOString(),
      },
      body.data.position === "next",
    );
    return player.getSnapshot();
  });

  app.post("/api/sessions/:guildId/queue/batch", async (request, reply) => {
    const { guildId } = request.params as { guildId: string };
    const body = batchEnqueueSchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "Selecao de audios invalida." });
    }
    const player = players.get(guildId);
    if (!player) return reply.code(404).send({ error: "Sessao nao encontrada." });
    if (!player.getSnapshot().voiceChannelId) {
      return reply.code(409).send({ error: "Chame o bot para um canal pelo Discord primeiro." });
    }

    const tracks = body.data.trackIds.map((trackId) => library.get(trackId));
    if (tracks.some((track) => !track)) {
      return reply.code(404).send({ error: "Um ou mais audios nao foram encontrados." });
    }
    const orderedTracks = tracks.filter((track): track is NonNullable<typeof track> => Boolean(track));
    if (body.data.shuffle) {
      for (let index = orderedTracks.length - 1; index > 0; index -= 1) {
        const randomIndex = Math.floor(Math.random() * (index + 1));
        [orderedTracks[index], orderedTracks[randomIndex]] = [
          orderedTracks[randomIndex]!,
          orderedTracks[index]!,
        ];
      }
    }

    const requestedAt = new Date().toISOString();
    player.enqueueMany(orderedTracks.map((track) => ({
      ...track,
      requestedBy: requesterLabel(request),
      requestedAt,
    })));
    return {
      added: orderedTracks.length,
      shuffled: body.data.shuffle,
      trackIds: orderedTracks.map(({ id }) => id),
      session: player.getSnapshot(),
    };
  });

  app.post("/api/sessions/:guildId/queue/external", async (request, reply) => {
    const { guildId } = request.params as { guildId: string };
    const body = externalEnqueueSchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "Link externo invalido." });
    const player = players.get(guildId);
    if (!player) return reply.code(404).send({ error: "Sessao nao encontrada." });
    const channelId = player.getSnapshot().voiceChannelId;
    if (!channelId) {
      return reply.code(409).send({ error: "Chame o bot para um canal pelo Discord primeiro." });
    }
    try {
      const track = await externalSources.resolve(body.data.url);
      const principal = currentPrincipal(actorFor(request));
      if (!principal) return reply.code(401).send({ error: "Sessão encerrada." });
      if (!canRequest(principal, request.method, `/api/sessions/${guildId}/queue/external`, request.body)) {
        return reply.code(403).send({ error: "Seu perfil não permite esta ação ou este servidor." });
      }
      if (maintenance || players.get(guildId) !== player || player.getSnapshot().voiceChannelId !== channelId) {
        return reply.code(409).send({ error: "A sessão de áudio mudou durante a busca. Chame o bot e tente novamente." });
      }
      player.enqueue(
        {
          ...track,
          requestedBy: requesterLabel(request),
          requestedAt: new Date().toISOString(),
        },
        body.data.position === "next",
      );
      return player.getSnapshot();
    } catch (error) {
      return reply.code(422).send({ error: (error as Error).message });
    }
  });

  app.post("/api/sessions/:guildId/effects", async (request, reply) => {
    const { guildId } = request.params as { guildId: string };
    const body = effectSchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "Efeito invalido." });
    const player = players.get(guildId);
    if (!player) return reply.code(404).send({ error: "Sessao nao encontrada." });
    if (!player.getSnapshot().voiceChannelId) {
      return reply.code(409).send({ error: "Chame o bot para um canal pelo Discord primeiro." });
    }
    const track = library.get(body.data.trackId);
    if (!track || track.category !== "effect") {
      return reply.code(404).send({ error: "Efeito nao encontrado." });
    }
    try {
      player.playEffect({
        ...track,
        requestedBy: requesterLabel(request),
        requestedAt: new Date().toISOString(),
      });
      return player.getSnapshot();
    } catch (error) {
      return reply.code(409).send({ error: (error as Error).message });
    }
  });

  app.post("/api/sessions/:guildId/actions", async (request, reply) => {
    const { guildId } = request.params as { guildId: string };
    const body = actionSchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "Acao invalida." });
    const player = players.get(guildId);
    if (!player) return reply.code(404).send({ error: "Sessao nao encontrada." });

    switch (body.data.action) {
      case "pause":
        player.pause();
        break;
      case "resume":
        player.resume();
        break;
      case "skip":
        player.skip();
        break;
      case "stop":
        if (actorFor(request).principal.profile === "playback") player.stopMusic(); else player.stop();
        break;
      case "leave":
        player.leave();
        break;
      case "clear":
        player.clearUpcoming();
        break;
      case "volume":
        player.setVolume(body.data.value);
        break;
      case "effectVolume":
        player.setEffectVolume(body.data.value);
        break;
      case "loop":
        player.setRepeatMode(body.data.value);
        break;
    }
    return player.getSnapshot();
  });

  app.delete("/api/sessions/:guildId/queue/:index", async (request, reply) => {
    const { guildId, index } = request.params as { guildId: string; index: string };
    const player = players.get(guildId);
    if (!player) return reply.code(404).send({ error: "Sessao nao encontrada." });
    if (!player.remove(Number(index))) {
      return reply.code(404).send({ error: "Item da fila nao encontrado." });
    }
    return player.getSnapshot();
  });

  app.post("/api/sessions/:guildId/queue/:index/play", async (request, reply) => {
    const { guildId, index } = request.params as { guildId: string; index: string };
    const player = players.get(guildId);
    if (!player) return reply.code(404).send({ error: "Sessao nao encontrada." });
    if (!player.playUpcoming(Number(index))) {
      return reply.code(404).send({ error: "Item da fila nao encontrado." });
    }
    return player.getSnapshot();
  });

  app.patch("/api/sessions/:guildId/queue", async (request, reply) => {
    const { guildId } = request.params as { guildId: string };
    const body = reorderSchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "Reordenacao invalida." });
    const player = players.get(guildId);
    if (!player) return reply.code(404).send({ error: "Sessao nao encontrada." });
    if (!player.reorder(body.data.from, body.data.to)) {
      return reply.code(400).send({ error: "Nao foi possivel reordenar a fila." });
    }
    return player.getSnapshot();
  });

  const scenes = await registerStudioRoutes(app, { dataDir: config.dataDir, library, playlists, players, broadcast, requester: requesterLabel, isOwner: request => actorFor(request).principal.role === "owner" });
  const backups = new BackupService({ dataDir: config.dataDir, audioDir: config.audioDir, maxBytes: config.maxUploadBytes, library, playlists, scenes, players });
  app.route({ method: ["GET", "POST"], url: "/api/backups/export", handler: async (request, reply) => {
    if (actorFor(request).principal.role !== "owner") return reply.code(403).send({ error: "Somente o anfitrião pode exportar backups." });
    if (maintenance) return reply.code(503).send({ error: "Há outra operação de backup em andamento." });
    const body = z.object({ includeAudio: z.boolean().default(false) }).safeParse(request.method === "GET" ? { includeAudio: (request.query as { includeAudio?: string }).includeAudio === "true" } : request.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "Opção de backup inválida." });
    maintenance = true;
    try {
      const stream = await backups.export(body.data.includeAudio);
      stream.once("close", () => { maintenance = false; }); reply.raw.once("close", () => { stream.destroy(); maintenance = false; });
      return reply.type("application/gzip").header("Content-Disposition", 'attachment; filename="sonora-backup.sonora.gz"').send(stream);
    } catch { maintenance = false; return reply.code(500).send({ error: "Não foi possível criar o backup. Reindexe e confira seus arquivos." }); }
  } });
  app.post("/api/backups/restore", async (request, reply) => {
    if (actorFor(request).principal.role !== "owner") return reply.code(403).send({ error: "Somente o anfitrião pode restaurar backups." });
    if (request.headers["x-sonora-confirm"] !== "restore") return reply.code(400).send({ error: "Confirme a restauração antes de enviar." });
    maintenance = true;
    try {
      const upload = await request.file(); if (!upload) return reply.code(400).send({ error: "Envie um backup do Sonora." });
      const result = await backups.restore(upload.file);
      broadcast("state", {}); broadcast("studio", {});
      return { ...result, message: "Backup restaurado. Chame o bot novamente pelo Discord para retomar a fila." };
    } catch (error) { app.log.warn("Restauração de backup recusada ou interrompida."); return reply.code(400).send({ error: "Não foi possível restaurar. Confira o formato, a integridade, o limite MAX_UPLOAD_MB e as permissões das pastas." }); }
    finally { maintenance = false; }
  });

  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith("/api/")) {
      return reply.code(404).send({ error: "Rota nao encontrada." });
    }
    return reply.sendFile("index.html");
  });

  app.addHook("preClose", async () => {
    clearInterval(expirationTimer);
    for (const client of eventClients.keys()) client.end();
    eventClients.clear();
  });

  return app as unknown as AppServer;
}
