import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { PassThrough, type Readable } from "node:stream";
import { performance } from "node:perf_hooks";

import { LibraryService } from "../library/library-service.js";
import { describeYtDlpError, ExternalSourceService } from "../sources/external-source-service.js";
import type { PlayableTrack } from "../types.js";
import { PCM_FRAME_BYTES, type DecodedAudio } from "./pcm-mixer.js";

function stderrCollector(stream: Readable): () => string {
  let text = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    text = `${text}${chunk}`.slice(-4_000);
  });
  return () => text.trim();
}

function stopProcess(process: ChildProcessWithoutNullStreams | null): void {
  if (process && process.exitCode === null && process.signalCode === null) {
    process.kill("SIGKILL");
  }
}

export class AudioSourceFactory {
  constructor(
    private readonly library: LibraryService,
    private readonly externalSources: ExternalSourceService,
    private readonly timeouts = { startupMs: 45_000, stalledMs: 30_000 },
  ) {}

  create(track: PlayableTrack, loop = false): DecodedAudio {
    if (track.source !== "local") return this.createExternal(track);
    // Queues and saved scenes contain snapshots. A file may have moved since
    // that snapshot was created, so only the current catalog owns its path.
    const current = this.library.get(track.id);
    if (!current) {
      throw new Error("Este áudio não está mais na biblioteca. Reindexe a pasta e adicione-o novamente.");
    }
    return this.createLocal(this.library.resolvePath(current), loop);
  }

  private createLocal(fullPath: string, loop = false): DecodedAudio {
    return this.createFfmpegPipeline([...(loop ? ["-stream_loop", "-1"] : []), "-i", fullPath], null);
  }

  private createExternal(track: Extract<PlayableTrack, { source: "youtube" }>): DecodedAudio {
    const command = this.externalSources.streamCommand(track);
    const downloader = spawn(command.command, command.args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    downloader.stdin.end();
    return this.createFfmpegPipeline(["-i", "pipe:0"], downloader);
  }

  private createFfmpegPipeline(
    inputArgs: string[],
    downloader: ChildProcessWithoutNullStreams | null,
  ): DecodedAudio {
    const output = new PassThrough({ highWaterMark: PCM_FRAME_BYTES * 4 });
    const ffmpeg = spawn(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        ...inputArgs,
        "-map",
        "0:a:0",
        "-vn",
        "-sn",
        "-dn",
        "-ac",
        "2",
        "-ar",
        "48000",
        "-f",
        "s16le",
        "pipe:1",
      ],
      { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
    );
    const ffmpegError = stderrCollector(ffmpeg.stderr);
    const downloaderError = downloader ? stderrCollector(downloader.stderr) : () => "";
    let disposed = false;
    let receivedAudio = false;
    let decoderFinished = false;
    let lastAudioAt = performance.now();
    ffmpeg.stdout.on("data", () => { receivedAudio = true; lastAudioAt = performance.now(); });
    // The mixer emits silence while waiting for a decoder. Without a deadline,
    // a stalled download could leave a track "playing" forever. Backpressure
    // is intentional (including paused music) and must never count as a stall.
    const watchdog = setInterval(() => {
      if (disposed || decoderFinished) return;
      if (ffmpeg.stdout.isPaused() || output.writableNeedDrain || output.readableLength >= output.readableHighWaterMark) {
        lastAudioAt = performance.now();
        return;
      }
      const limit = receivedAudio ? this.timeouts.stalledMs : this.timeouts.startupMs;
      if (performance.now() - lastAudioAt < limit) return;
      output.destroy(new Error(receivedAudio
        ? "A fonte de áudio parou de enviar dados. Tente reproduzir novamente."
        : "A fonte de áudio demorou demais para iniciar. Verifique o arquivo ou a conexão com o YouTube."));
    }, Math.max(1, Math.min(1_000, this.timeouts.startupMs, this.timeouts.stalledMs)));
    watchdog.unref();

    if (downloader) {
      downloader.stdout.pipe(ffmpeg.stdin);
      ffmpeg.stdin.on("error", (error: NodeJS.ErrnoException) => {
        if (error.code !== "EPIPE" && !disposed) output.destroy(error);
      });
      downloader.on("error", (error) => output.destroy(new Error(describeYtDlpError(error))));
      downloader.on("close", (code, signal) => {
        if (!disposed && code !== 0) {
          stopProcess(ffmpeg);
          output.destroy(
            new Error(
              `yt-dlp encerrou com ${signal ?? `codigo ${code}`}: ${describeYtDlpError({ stderr: downloaderError() || "sem detalhes" })}`,
            ),
          );
        }
      });
    } else {
      ffmpeg.stdin.end();
    }

    ffmpeg.stdout.pipe(output, { end: false });
    ffmpeg.on("error", (error) => output.destroy(error));
    ffmpeg.on("close", (code, signal) => {
      decoderFinished = true;
      if (disposed) return;
      if (code === 0) {
        output.end();
      } else {
        stopProcess(downloader);
        output.destroy(
          new Error(
            /^ERROR:/im.test(downloaderError())
              ? `Falha ao receber áudio do YouTube: ${describeYtDlpError({ stderr: downloaderError() })}`
              : `FFmpeg encerrou com ${signal ?? `codigo ${code}`}: ${ffmpegError() || "sem detalhes"}`,
          ),
        );
      }
    });

    const dispose = (): void => {
      if (disposed) return;
      disposed = true;
      clearInterval(watchdog);
      stopProcess(downloader);
      stopProcess(ffmpeg);
      if (!output.destroyed) output.destroy();
    };
    output.once("close", () => {
      if (!disposed) dispose();
    });

    return { stream: output, dispose };
  }
}
