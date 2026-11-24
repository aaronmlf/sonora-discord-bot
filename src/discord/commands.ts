import { SlashCommandBuilder } from "discord.js";

export const commands = [
  new SlashCommandBuilder()
    .setName("play")
    .setDescription("Toca uma faixa local ou um link do YouTube/Spotify")
    .addStringOption((option) =>
      option
        .setName("audio")
        .setDescription("Nome local ou link do YouTube/Spotify")
        .setRequired(true)
        .setAutocomplete(true),
    ),
  new SlashCommandBuilder()
    .setName("effect")
    .setDescription("Toca um efeito sobre a musica sem interrompe-la")
    .addStringOption((option) =>
      option
        .setName("audio")
        .setDescription("Efeito da soundboard")
        .setRequired(true)
        .setAutocomplete(true),
    ),
  new SlashCommandBuilder()
    .setName("join")
    .setDescription("Faz o bot entrar no seu canal de voz"),
  new SlashCommandBuilder()
    .setName("pause")
    .setDescription("Pausa a reproducao atual"),
  new SlashCommandBuilder()
    .setName("resume")
    .setDescription("Retoma a reproducao pausada"),
  new SlashCommandBuilder()
    .setName("skip")
    .setDescription("Pula para o proximo audio da fila"),
  new SlashCommandBuilder()
    .setName("stop")
    .setDescription("Para a reproducao e limpa a fila"),
  new SlashCommandBuilder()
    .setName("queue")
    .setDescription("Mostra a fila de reproducao"),
  new SlashCommandBuilder()
    .setName("loop")
    .setDescription("Altera o modo de repeticao")
    .addStringOption((option) =>
      option
        .setName("modo")
        .setDescription("O que deve ser repetido")
        .setRequired(true)
        .addChoices(
          { name: "Desligado", value: "off" },
          { name: "Faixa atual", value: "track" },
          { name: "Fila inteira", value: "queue" },
        ),
    ),
  new SlashCommandBuilder()
    .setName("volume")
    .setDescription("Altera o volume da reproducao")
    .addIntegerOption((option) =>
      option
        .setName("nivel")
        .setDescription("Volume entre 0 e 100")
        .setMinValue(0)
        .setMaxValue(100)
        .setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName("leave")
    .setDescription("Para a reproducao e sai do canal de voz"),
].map((command) => command.toJSON());
