import assert from "node:assert/strict";
import { it } from "node:test";
import { DiscordBot } from "../src/discord/discord-bot.js";
import { loadConfig } from "../src/config.js";
import type { LibraryService } from "../src/library/library-service.js";
import type { ExternalSourceService } from "../src/sources/external-source-service.js";
import type { PlayerManager } from "../src/player/player-manager.js";
import type { GuildPlayer } from "../src/player/guild-player.js";
import type { SessionSnapshot } from "../src/types.js";
import { PermissionsBitField, PermissionFlagsBits, type ChatInputCommandInteraction, type GuildMember } from "discord.js";

function fixture(code: string) {
  const bot = new DiscordBot(loadConfig({ DISCORD_TOKEN: "test", DISCORD_CLIENT_ID: "test" }), {} as LibraryService, {} as ExternalSourceService, {} as PlayerManager);
  const client = (bot as unknown as { client: { login: () => Promise<void> } }).client;
  client.login = async () => { throw Object.assign(new Error("test failure"), { code }); };
  return bot;
}

it("agenda outra tentativa apos timeout e cancela ao encerrar", async () => {
  const bot = fixture("UND_ERR_CONNECT_TIMEOUT");
  await bot.start();
  assert.equal(bot.getStatus().state, "retrying");
  assert.ok(bot.getStatus().nextRetryAt);
  assert.equal(bot.getStatus().connected, false);
  await bot.stop();
  assert.equal(bot.getStatus().nextRetryAt, null);
});

it("nao repete login com token invalido", async () => {
  const bot = fixture("TokenInvalid");
  await bot.start();
  assert.equal(bot.getStatus().state, "invalid_config");
  assert.equal(bot.getStatus().nextRetryAt, null);
  await bot.stop();
});

it("reports missing voice permissions before attempting a connection", async () => {
  const bot = fixture("test");
  const internal = bot as unknown as { connectToMemberChannel: (interaction: ChatInputCommandInteraction, member: GuildMember) => Promise<unknown> };
  const channel = { id: "channel", name: "Mesa", permissionsFor: () => new PermissionsBitField([PermissionFlagsBits.ViewChannel]) };
  try {
    await assert.rejects(internal.connectToMemberChannel(
      { guild: { members: { me: {} } } } as unknown as ChatInputCommandInteraction,
      { voice: { channel } } as unknown as GuildMember,
    ), /faltam permissões.*Conectar, Falar/);
  } finally { await bot.stop(); }
});

it("fits command failures within Discord's response limit", async () => {
  const bot = fixture("test");
  const internal = bot as unknown as { playCommand: () => Promise<void>; handleCommand: (interaction: ChatInputCommandInteraction) => Promise<void> };
  internal.playCommand = async () => { throw new Error("x".repeat(4000)); };
  let message = "";
  try {
    await internal.handleCommand({ commandName: "play", deferred: true, editReply: async ({ content }: { content: string }) => { message = content; } } as unknown as ChatInputCommandInteraction);
    assert.ok(message.startsWith("Nao foi possivel concluir:"));
    assert.ok(message.length <= 2000);
  } finally { await bot.stop(); }
});

it("fits a long queue in Discord's limit and marks paused/loading music accurately", async () => {
  const bot = fixture("test");
  const internal = bot as unknown as { queueCommand: (interaction: ChatInputCommandInteraction) => Promise<void>; getControlledPlayer: () => Promise<GuildPlayer>; trackLabel: (track: { title: string; artist: string }) => string; client: { options: { allowedMentions: { parse: string[]; repliedUser: boolean } } } };
  let content = "";
  const longTrack = { title: "@everyone " + "t".repeat(3_000), artist: "a".repeat(3_000), requestedBy: "u".repeat(100) };
  const snapshot = { current: longTrack, upcoming: Array.from({ length: 20 }, () => longTrack), status: "paused" } as unknown as SessionSnapshot;
  internal.getControlledPlayer = async () => ({ getSnapshot: () => snapshot }) as unknown as GuildPlayer;
  const interaction = { deferReply: async () => {}, editReply: async (reply: { content: string }) => { content = reply.content; } } as unknown as ChatInputCommandInteraction;
  try {
    await internal.queueCommand(interaction);
    assert.ok(content.length <= 2_000); assert.match(content, /^Pausado:/); assert.match(content, /fila completa no painel/);
    snapshot.status = "buffering"; await internal.queueCommand(interaction);
    assert.match(content, /^Carregando:/);
    assert.ok(internal.trackLabel(longTrack).length <= 160, "Successful play/effect replies must also bound metadata");
    assert.deepEqual(internal.client.options.allowedMentions.parse, [], "Track names must not ping roles or users");
    assert.equal(internal.client.options.allowedMentions.repliedUser, false);
  } finally { await bot.stop(); }
});

it("awaits Discord shutdown and ignores late login/disconnect events", async () => {
  const bot = fixture("test");
  const client = (bot as unknown as { client: { login: () => Promise<void>; destroy: () => Promise<void>; emit: (event: string) => boolean } }).client;
  let rejectLogin!: (error: Error) => void;
  let finishDestroy!: () => void;
  client.login = () => new Promise<void>((_resolve, reject) => { rejectLogin = reject; });
  client.destroy = () => new Promise<void>(resolve => { finishDestroy = resolve; });
  const starting = bot.start();
  let stopped = false;
  const stopping = bot.stop().then(() => { stopped = true; });
  await Promise.resolve();
  assert.equal(stopped, false, "stop must await the Discord connection cleanup");
  rejectLogin(Object.assign(new Error("late connection failure"), { code: "ECONNRESET" }));
  await starting;
  client.emit("shardDisconnect"); client.emit("shardResume");
  assert.equal(bot.getStatus().state, "disconnected");
  assert.equal(bot.getStatus().connected, false); assert.equal(bot.getStatus().nextRetryAt, null);
  finishDestroy(); await stopping;
  assert.equal(stopped, true);
});
