import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { describeYtDlpError, ExternalSourceService } from "../src/sources/external-source-service.js";
import type { ExternalTrack } from "../src/types.js";

const track: ExternalTrack = {
  id: "youtube:example", source: "youtube", category: "music", title: "Teste",
  webpageUrl: "https://www.youtube.com/watch?v=example",
  originalUrl: "https://www.youtube.com/watch?v=example", resolvedFrom: "youtube",
};

describe("ExternalSourceService", () => {
  it("aceita somente hosts conhecidos", () => {
    const service = new ExternalSourceService({
      ytDlpPath: "yt-dlp",
      infoRunner: async () => ({}),
    });
    assert.equal(service.providerFor("https://youtu.be/video"), "youtube");
    assert.equal(service.providerFor("https://music.youtube.com/watch?v=video"), "youtube");
    assert.equal(service.providerFor("https://open.spotify.com/track/id"), "spotify");
    assert.equal(service.providerFor("https://youtube.com.example.org/watch?v=x"), null);
    assert.equal(service.providerFor("file:///etc/passwd"), null);
  });

  it("resolve metadados de um link do YouTube", async () => {
    const service = new ExternalSourceService({
      ytDlpPath: "yt-dlp",
      infoRunner: async () => ({
        id: "abc",
        title: "Faixa de teste",
        uploader: "Canal",
        duration: 42,
        webpage_url: "https://www.youtube.com/watch?v=abc",
      }),
    });
    const result = await service.resolve("https://youtu.be/abc");
    assert.equal(result.id, "youtube:abc");
    assert.equal(result.source, "youtube");
    assert.equal(result.durationMs, 42_000);
    assert.equal(result.resolvedFrom, "youtube");
  });

  it("converte uma faixa do Spotify em busca no YouTube", async () => {
    let lookup = "";
    const fetchImpl: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          title: "Musica Exemplo",
          html: '<iframe src="https://open.spotify.com/embed/track/123"></iframe>',
          thumbnail_url: "https://i.scdn.co/image/example",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    const service = new ExternalSourceService({
      ytDlpPath: "yt-dlp",
      fetchImpl,
      infoRunner: async (input) => {
        lookup = input;
        return {
          id: "youtube-result",
          title: "Musica Exemplo (Official Audio)",
          webpage_url: "https://www.youtube.com/watch?v=youtube-result",
        };
      },
    });
    const spotifyUrl = "https://open.spotify.com/track/123";
    const result = await service.resolve(spotifyUrl);

    assert.equal(lookup, "ytsearch1:Musica Exemplo official audio");
    assert.equal(result.resolvedFrom, "spotify");
    assert.equal(result.originalUrl, spotifyUrl);
    assert.equal(result.thumbnailUrl, "https://i.scdn.co/image/example");
  });

  it("recusa playlists do Spotify nesta versao", async () => {
    const service = new ExternalSourceService({
      ytDlpPath: "yt-dlp",
      infoRunner: async () => ({}),
    });
    await assert.rejects(
      service.resolve("https://open.spotify.com/playlist/123"),
      /devem apontar para uma faixa/,
    );
  });

  it("aceita links localizados do Spotify sem repassar parametros de compartilhamento", async () => {
    let oembedUrl = "";
    const service = new ExternalSourceService({
      ytDlpPath: "yt-dlp",
      fetchImpl: async (url) => {
        oembedUrl = new URL(String(url)).searchParams.get("url") ?? "";
        return new Response(JSON.stringify({ title: "Musica", html: '<iframe src="https://open.spotify.com/embed/track/123"></iframe>' }));
      },
      infoRunner: async () => ({ id: "example", title: "Musica", webpage_url: track.webpageUrl }),
    });
    const original = "https://open.spotify.com/intl-pt/track/123?si=compartilhamento";
    assert.equal((await service.resolve(original)).originalUrl, original);
    assert.equal(oembedUrl, "https://open.spotify.com/track/123");
    await assert.rejects(service.resolve("https://open.spotify.com/intl-pt/playlist/123"), /faixa/);
  });

  it("consulta somente o video de links com playlist, Shorts e compartilhamento", async () => {
    const lookups: string[] = [];
    const service = new ExternalSourceService({
      ytDlpPath: "yt-dlp",
      infoRunner: async (url) => {
        lookups.push(url);
        return { id: "example", title: "Musica", webpage_url: track.webpageUrl };
      },
    });
    await service.resolve("https://youtu.be/example?si=xyz");
    await service.resolve("https://www.youtube.com/watch?v=example&list=lista&index=2");
    await service.resolve("https://www.youtube.com/shorts/example");
    assert.deepEqual(lookups, Array(3).fill(track.webpageUrl));
    await assert.rejects(service.resolve("https://www.youtube.com/playlist?list=lista"), /video individual/);
    await assert.rejects(service.resolve("https://www.youtube.com/@canal"), /video individual/);
    assert.equal(lookups.length, 3);
  });

  it("habilita Node e limita espera/repeticoes no streaming sem configuracao global", () => {
    const service = new ExternalSourceService({ ytDlpPath: "/custom/yt-dlp" });
    const command = service.streamCommand(track);
    const argument = (flag: string) => command.args[command.args.indexOf(flag) + 1];
    assert.equal(command.command, "/custom/yt-dlp");
    assert.ok(command.args.includes("--ignore-config"));
    assert.ok(command.args.includes("--abort-on-unavailable-fragments"));
    assert.equal(argument("--socket-timeout"), "15");
    assert.equal(argument("--retries"), "2");
    assert.equal(argument("--fragment-retries"), "2");
    assert.equal(argument("--js-runtimes"), `node:${process.execPath}`);
    assert.equal(argument("--extractor-args"), "youtube:player_client=web_embedded,android_vr;player_js_variant=tv");
    assert.equal(command.args.filter((value) => value === "--extractor-args").length, 1);
    assert.equal(argument("-o"), "-");
    assert.match(argument("-f") ?? "", /^bestaudio/);
    assert.deepEqual(command.args.slice(-2), ["--", track.webpageUrl]);
    assert.equal(command.args.includes("--no-warnings"), false);
  });

  it("mantem cookies explicitos e nao força clientes anonimos quando configurados", () => {
    const service = new ExternalSourceService({ ytDlpPath: "yt-dlp", cookiesFile: "/private/cookies.txt" });
    const { args } = service.streamCommand(track);
    assert.equal(args[args.indexOf("--cookies") + 1], "/private/cookies.txt");
    assert.equal(args[args.indexOf("--extractor-args") + 1], "youtube:player_js_variant=tv");
  });

  it("explica bloqueios externos e falhas de dependencia sem despejar o comando", async () => {
    const service = new ExternalSourceService({
      ytDlpPath: "yt-dlp",
      infoRunner: async () => { throw { message: "Command failed: secret-cookie-path", stderr: "ERROR: Sign in to confirm you’re not a bot" }; },
    });
    await assert.rejects(service.resolve(track.webpageUrl), (error: Error) => {
      assert.match(error.message, /anti-bot/);
      assert.doesNotMatch(error.message, /secret-cookie/);
      return true;
    });
    assert.match(describeYtDlpError({ code: "ENOENT" }), /YTDLP_PATH/);
    assert.match(describeYtDlpError({ killed: true }), /tempo limite/);
    assert.match(describeYtDlpError(new Error("no such option: --js-runtimes")), /desatualizado/);
    assert.match(describeYtDlpError(new Error("No supported JavaScript runtime")), /JavaScript/);
    assert.equal(describeYtDlpError({ stderr: "WARNING: something\nERROR: Video unavailable" }), "Video unavailable");
  });

  it("nao troca o erro final por avisos sobre outros formatos ou sobre JavaScript", () => {
    const warning = "WARNING: n challenge solving failed. Ensure a supported JavaScript runtime is installed.";
    assert.match(describeYtDlpError({ stderr: `${warning}\nERROR: unable to download video data: HTTP Error 403: Forbidden` }), /HTTP 403/);
    assert.equal(describeYtDlpError({ stderr: `${warning}\nERROR: Video unavailable` }), "Video unavailable");
    assert.match(describeYtDlpError({ stderr: `${warning}\nERROR: Requested format is not available.` }), /formato reproduzivel.*JavaScript/);
    assert.match(describeYtDlpError({ stderr: "WARNING: Error solving n challenge request using node" }), /Atualize o yt-dlp e o EJS/);
    assert.doesNotMatch(describeYtDlpError(new Error("Command failed: yt-dlp --cookies confidential.txt")), /confidential/);
  });
});
