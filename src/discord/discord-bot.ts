import { EventEmitter } from "node:events";

import {
  DiscordGatewayAdapterCreator,
  VoiceConnectionStatus,
  entersState,
  joinVoiceChannel,
} from "@discordjs/voice";
import {
  AutocompleteInteraction,
  ChatInputCommandInteraction,
  Client,
  Events,
  GatewayIntentBits,
  GuildMember,
  MessageFlags,
  PermissionFlagsBits,
} from "discord.js";

import type { AppConfig } from "../config.js";
import { LibraryService } from "../library/library-service.js";
import { PlayerManager } from "../player/player-manager.js";
import type { GuildPlayer } from "../player/guild-player.js";
import { ExternalSourceService } from "../sources/external-source-service.js";
import type { PlayableTrack, QueuedTrack, RepeatMode } from "../types.js";
import { commands } from "./commands.js";

export interface BotStatus {
  configured: boolean;
  connected: boolean;
  username: string | null;
  state: string;
  lastError: string | null;
  nextRetryAt: string | null;
  commandsRegistered: boolean;
}

export class DiscordBot extends EventEmitter {
  private readonly client: Client;
  private connected = false;
  private state = "disconnected";
  private lastError: string | null = null;
  private nextRetryAt: string | null = null;
  private commandsRegistered = false;
  private stopped = false;
  private retryTimer: NodeJS.Timeout | undefined;
  private attempts = 0;
  private connecting = false;

  private report(error: unknown): void {
    if (this.stopped) return;
    const code = String((error as { code?: unknown })?.code ?? "UNKNOWN");
    this.lastError = `Falha de comunicação (${code}).`;
    this.emit("status", this.getStatus());
  }

  constructor(
    private readonly config: AppConfig,
    private readonly library: LibraryService,
    private readonly externalSources: ExternalSourceService,
    private readonly players: PlayerManager,
  ) {
    super();
    this.client = new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
      // Audio metadata and requester names are user-controlled text, not an
      // instruction to ping people or roles in command responses.
      allowedMentions: { parse: [], repliedUser: false },
    });

    this.client.on("interactionCreate", (interaction) => {
      if (interaction.isAutocomplete()) {
        void this.handleAutocomplete(interaction).catch((error) => this.report(error));
      } else if (interaction.isChatInputCommand()) {
        void this.handleCommand(interaction).catch((error) => this.report(error));
      }
    });
    this.client.on(Events.ClientReady, async () => {
      if (this.stopped) return;
      this.connected = true;
      this.state = "connected";
      this.attempts = 0;
      this.lastError = null;
      this.nextRetryAt = null;
      this.emit("status", this.getStatus());
      try {
        await this.registerCommands();
        if (!this.stopped) this.commandsRegistered = true;
      } catch (error) { this.report(error); }
      if (!this.stopped) this.emit("status", this.getStatus());
    });
    this.client.on("shardDisconnect", () => {
      if (this.stopped) return;
      this.connected = false;
      this.state = "retrying";
      this.emit("status", this.getStatus());
    });
    this.client.on("shardResume", () => {
      if (this.stopped) return;
      this.connected = true;
      this.state = "connected";
      this.emit("status", this.getStatus());
    });
    this.client.on(Events.Error, (error) => this.report(error));
  }

  getStatus(): BotStatus {
    return {
      configured: Boolean(this.config.discordToken && this.config.discordClientId),
      connected: this.connected,
      username: this.client.user?.username ?? null,
      state: this.state,
      lastError: this.lastError,
      nextRetryAt: this.nextRetryAt,
      commandsRegistered: this.commandsRegistered,
    };
  }

  async start(): Promise<void> {
    if (this.stopped || this.connecting || this.connected) return;
    if (!this.config.discordToken || !this.config.discordClientId) {
      this.state = "invalid_config";
      this.lastError = "Preencha DISCORD_TOKEN e DISCORD_CLIENT_ID e reinicie o Sonora.";
      this.emit("status", this.getStatus());
      return;
    }
    this.connecting = true;
    this.state = "connecting";
    this.nextRetryAt = null;
    this.emit("status", this.getStatus());
    try {
      await this.client.login(this.config.discordToken);
    } catch (error) {
      if (this.stopped) return;
      this.connected = false;
      const code = String((error as { code?: unknown })?.code ?? "UNKNOWN");
      const invalid = code === "TokenInvalid" || code === "TOKEN_INVALID" || code === "401";
      this.state = invalid ? "invalid_config" : "retrying";
      this.lastError = invalid ? "Token do Discord inválido. Confira a configuração e reinicie." : `Não foi possível conectar ao Discord (${code}).`;
      if (!invalid && !this.stopped) {
        const delay = Math.min(60_000, 2_000 * 2 ** Math.min(this.attempts++, 5));
        this.nextRetryAt = new Date(Date.now() + delay).toISOString();
        this.retryTimer = setTimeout(() => void this.start(), delay);
        this.retryTimer.unref();
      }
      this.emit("status", this.getStatus());
    } finally { this.connecting = false; }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    this.state = "disconnected";
    this.nextRetryAt = null;
    this.connected = false;
    try { await this.client.destroy(); }
    finally { this.emit("status", this.getStatus()); }
  }

  private async registerCommands(): Promise<void> {
    if (!this.client.application) return;

    if (this.config.discordGuildId) {
      const guild = await this.client.guilds.fetch(this.config.discordGuildId);
      await guild.commands.set(commands);
      return;
    }

    await this.client.application.commands.set(commands);
  }

  private async handleAutocomplete(interaction: AutocompleteInteraction): Promise<void> {
    const query = interaction.options.getFocused();
    const results = this.library
      .search(query, interaction.commandName === "effect" ? "effect" : undefined)
      .slice(0, 25);
    await interaction.respond(
      results.map((track) => ({
        name: `${track.category === "effect" ? "Efeito" : "Musica"} · ${this.trackLabel(track)}`.slice(
          0,
          100,
        ),
        value: track.id,
      })),
    );
  }

  private async handleCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    try {
      switch (interaction.commandName) {
        case "play":
          await this.playCommand(interaction);
          break;
        case "effect":
          await this.effectCommand(interaction);
          break;
        case "join":
          await this.joinCommand(interaction);
          break;
        case "queue":
          await this.queueCommand(interaction);
          break;
        default:
          await this.controlCommand(interaction);
      }
    } catch (error) {
      // Discord rejects responses over 2,000 characters; stderr can be longer.
      const message = `Nao foi possivel concluir: ${(error as Error).message}`.slice(0, 1_950);
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ content: message });
      } else {
        await interaction.reply({ content: message, flags: MessageFlags.Ephemeral });
      }
    }
  }

  private async playCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply();
    const member = await this.getMember(interaction);
    const voiceChannel = member.voice.channel;
    if (!voiceChannel || !interaction.guild) {
      throw new Error("entre em um canal de voz antes de usar /play.");
    }

    const requested = interaction.options.getString("audio", true);
    let track: PlayableTrack | undefined =
      this.library.get(requested) ?? this.library.search(requested)[0];
    if (!track && this.externalSources.isSupportedUrl(requested)) {
      track = await this.externalSources.resolve(requested);
    }
    if (!track) {
      throw new Error(
        "nenhum audio local foi encontrado; use um nome ou link do YouTube/Spotify.",
      );
    }

    const existing = this.players.get(interaction.guild.id);
    const snapshot = existing?.getSnapshot();
    if (snapshot?.voiceChannelId && snapshot.voiceChannelId !== voiceChannel.id) {
      throw new Error(`o bot ja esta em #${snapshot.voiceChannelName ?? "outro canal"}.`);
    }

    const player = await this.connectToMemberChannel(interaction, member);
    const queued = this.toQueuedTrack(track, interaction.user.displayName);
    player.enqueue(queued);
    const position = player.getSnapshot().upcoming.length;

    await interaction.editReply({
      content:
        position === 0
          ? `Preparando reprodução: **${this.trackLabel(track)}**. Acompanhe o carregamento no painel.`
          : `Adicionado a fila (#${position}): **${this.trackLabel(track)}**`,
    });
  }

  private async effectCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply();
    const member = await this.getMember(interaction);
    if (!member.voice.channel || !interaction.guild) {
      throw new Error("entre em um canal de voz antes de usar /effect.");
    }
    const requested = interaction.options.getString("audio", true);
    const direct = this.library.get(requested);
    const track =
      direct?.category === "effect"
        ? direct
        : this.library.search(requested, "effect")[0];
    if (!track) throw new Error("nenhum efeito foi encontrado na soundboard.");

    const existing = this.players.get(interaction.guild.id);
    const snapshot = existing?.getSnapshot();
    if (snapshot?.voiceChannelId && snapshot.voiceChannelId !== member.voice.channel.id) {
      throw new Error(`o bot ja esta em #${snapshot.voiceChannelName ?? "outro canal"}.`);
    }
    const player = await this.connectToMemberChannel(interaction, member);
    player.playEffect(this.toQueuedTrack(track, interaction.user.displayName));
    await interaction.editReply({
      content: `Efeito disparado: **${this.trackLabel(track)}**`,
    });
  }

  private async joinCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply();
    const member = await this.getMember(interaction);
    if (!member.voice.channel) {
      throw new Error("entre em um canal de voz antes de usar /join.");
    }
    await this.connectToMemberChannel(interaction, member);
    await interaction.editReply({ content: `Conectado a **${member.voice.channel.name}**.` });
  }

  private async queueCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply();
    const player = await this.getControlledPlayer(interaction, false);
    const snapshot = player.getSnapshot();
    const current = snapshot.current
      ? `${snapshot.status === "paused" ? "Pausado" : snapshot.status === "buffering" ? "Carregando" : "Tocando"}: **${this.trackLabel(snapshot.current)}**`
      : "Nada tocando agora.";
    const lines = [current];
    let shown = 0;
    for (const track of snapshot.upcoming.slice(0, 10)) {
      const line = `${shown + 1}. ${this.trackLabel(track)} — ${track.requestedBy.slice(0, 60)}`;
      if (lines.join("\n").length + line.length + 1 > 1_850) break;
      lines.push(line); shown++;
    }
    if (!snapshot.upcoming.length) lines.push("A fila esta vazia.");
    else if (shown < snapshot.upcoming.length) lines.push(`Mais ${snapshot.upcoming.length - shown} áudio(s). Veja a fila completa no painel.`);
    await interaction.editReply({ content: lines.join("\n") });
  }

  private async controlCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply();
    const player = await this.getControlledPlayer(interaction);
    let response: string;

    switch (interaction.commandName) {
      case "pause":
        response = player.pause() ? "Música pausada. Ambientes e efeitos continuam." : "Não há música tocando.";
        break;
      case "resume":
        response = player.resume() ? "Reproducao retomada." : "O audio nao esta pausado.";
        break;
      case "skip":
        response = player.skip() ? "Audio pulado." : "Nao ha audio para pular.";
        break;
      case "stop":
        player.stop();
        response = "Música, ambientes e efeitos parados. Fila limpa.";
        break;
      case "loop": {
        const mode = interaction.options.getString("modo", true) as RepeatMode;
        player.setRepeatMode(mode);
        response = `Modo de repeticao alterado para **${mode}**.`;
        break;
      }
      case "volume": {
        const volume = interaction.options.getInteger("nivel", true);
        player.setVolume(volume);
        response = `Volume alterado para **${volume}%**.`;
        break;
      }
      case "leave":
        player.leave();
        response = "Sai do canal de voz e limpei a fila.";
        break;
      default:
        throw new Error("comando desconhecido.");
    }

    await interaction.editReply({ content: response });
  }

  private async getControlledPlayer(
    interaction: ChatInputCommandInteraction,
    requireSameChannel = true,
  ): Promise<GuildPlayer> {
    if (!interaction.guild) throw new Error("este comando so funciona em servidores.");
    const player = this.players.get(interaction.guild.id);
    if (!player) throw new Error("nao existe uma sessao de audio neste servidor.");

    if (requireSameChannel) {
      const member = await this.getMember(interaction);
      const voiceChannel = member.voice.channel;
      const snapshot = player.getSnapshot();
      if (!voiceChannel || voiceChannel.id !== snapshot.voiceChannelId) {
        throw new Error("entre no mesmo canal de voz do bot para controla-lo.");
      }
    }
    return player;
  }

  private async getMember(interaction: ChatInputCommandInteraction): Promise<GuildMember> {
    if (!interaction.guild) throw new Error("este comando so funciona em servidores.");
    if (interaction.member instanceof GuildMember) return interaction.member;
    return interaction.guild.members.fetch(interaction.user.id);
  }

  private async connectToMemberChannel(
    interaction: ChatInputCommandInteraction,
    member: GuildMember,
  ): Promise<GuildPlayer> {
    const guild = interaction.guild;
    const channel = member.voice.channel;
    if (!guild || !channel) throw new Error("canal de voz nao encontrado.");

    const me = guild.members.me ?? await guild.members.fetchMe();
    const permissions = channel.permissionsFor(me);
    const missing = [
      [PermissionFlagsBits.ViewChannel, "Ver canais"],
      [PermissionFlagsBits.Connect, "Conectar"],
      [PermissionFlagsBits.Speak, "Falar"],
    ] as const;
    const denied = missing.filter(([permission]) => !permissions?.has(permission)).map(([, name]) => name);
    if (denied.length) throw new Error(`faltam permissões do bot em #${channel.name}: ${denied.join(", ")}. Confira também as permissões específicas do canal.`);

    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator as DiscordGatewayAdapterCreator,
      selfDeaf: true,
      selfMute: false,
    });

    let voiceError: Error | null = null;
    const onError = (error: Error): void => { voiceError = error; };
    connection.on("error", onError);
    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
      return this.players.attachConnection(guild.id, guild.name, connection, {
        id: channel.id,
        name: channel.name,
      });
    } catch {
      if (connection.state.status !== VoiceConnectionStatus.Destroyed) connection.destroy();
      const detail = voiceError ? ` Detalhe: ${(voiceError as Error).message}` : " Verifique se a rede/VPN/firewall permite a conexão de voz UDP do Discord.";
      throw new Error(`não consegui estabelecer a conexão de voz em 20 segundos.${detail}`);
    } finally {
      connection.off("error", onError);
    }
  }

  private toQueuedTrack(track: PlayableTrack, requestedBy: string): QueuedTrack {
    return {
      ...track,
      requestedBy,
      requestedAt: new Date().toISOString(),
    };
  }

  private trackLabel(track: Pick<PlayableTrack, "title" | "artist">): string {
    const label = track.artist ? `${track.title} — ${track.artist}` : track.title;
    return label.length > 160 ? `${label.slice(0, 159)}…` : label;
  }
}
