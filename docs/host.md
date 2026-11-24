# Rodar o Sonora em um aparelho dedicado

Seu bot pode ficar disponível enquanto o Sonora estiver rodando em um aparelho ligado e com internet. Um PC ou mini-PC Linux é a opção mais previsível para ficar ligado o dia todo. Um Android antigo é uma alternativa para testar com o Termux. O bot continua entrando na chamada quando alguém usa `/join` ou `/play`.

Se ainda não tiver um bot, siga primeiro a [preparação no Discord](../README.md#preparação-no-discord). Se já tiver, você pode manter a mesma aplicação e só trocar o aparelho que hospeda o Sonora. Para Windows, siga o [guia de instalação para Windows](windows.md).

## Levar o bot para outro aparelho

Baixe **`sonora-host.tar.gz`** em **Assets** na [última versão do Sonora](https://github.com/aaronmlf/sonora-discord-bot/releases/latest). Esse arquivo extrai uma pasta `sonora` com o JavaScript pronto. O pacote não contém músicas, configurações privadas, credenciais nem dependências específicas do computador que o compilou. Não baixe o arquivo automático **Source code** para estas instruções. Para compilar e empacotar a sua própria versão, use `npm run host:pack` em um PC com as dependências de desenvolvimento instaladas.

1. Extraia o pacote no armazenamento do novo host e entre na pasta `sonora`.
2. Instale Node.js 22.12 ou superior, FFmpeg e FFprobe. Para usar links externos, instale também `yt-dlp` e o componente EJS da sua distribuição.
3. Instale as dependências no aparelho com `npm ci --omit=dev --include=optional`. Isso seleciona as bibliotecas da arquitetura do aparelho.
4. Crie `.env` a partir de `.env.example`. Para manter o mesmo bot no Discord, use o token e o ID da aplicação existentes. Mantenha o `.env` privado no host de confiança.
5. Rode `npm run host:check`. Ele verifica a configuração, FFmpeg, FFprobe, Opus e a criptografia de voz DAVE localmente. O `yt-dlp` é opcional para arquivos locais.

Pare a instância anterior antes de iniciar a nova com o mesmo token. Para mudar também sua biblioteca, copie de forma privada a pasta de áudio inteira, inclusive subpastas e a lixeira, e os arquivos `library.json`, `playlists.json`, `scenes.json` e `sessions.json` que existirem em `DATA_DIR`. Faça a cópia com o bot parado e preserve os caminhos relativos em `AUDIO_DIR`. Para transferências menores, o painel também tem **Preferências → Backup e restauração**. A exportação com áudios é opcional e respeita o limite configurado.

Inicie com `npm start` no primeiro teste. Confirme `/join` e `/play` com um arquivo local. Depois experimente um link externo, se for usar essa função. O diagnóstico local não verifica a conexão de voz do seu aparelho com o Discord.

## PC Linux

Instale [Node.js LTS](https://nodejs.org/en/download) (mínimo 22.12) e FFmpeg/FFprobe para sua distribuição. No Debian/Ubuntu, por exemplo, instale FFmpeg com `sudo apt install ffmpeg`; no Fedora, use `sudo dnf install ffmpeg-free` (essa variante tem [menos codecs](https://packages.fedoraproject.org/pkgs/ffmpeg/ffmpeg-free/)). Verifique com `node --version`, `npm --version`, `ffmpeg -version` e `ffprobe -version`. Se o Node do repositório da distribuição for antigo demais, use a opção apropriada na página oficial de download do Node.js.

Abra o terminal na pasta que contém o arquivo baixado. Use um local em que você possa gravar e que não tenha uma pasta `sonora` de outra instalação. Execute:

```sh
tar -xzf sonora-host.tar.gz
cd sonora
npm ci --omit=dev --include=optional
cp .env.example .env
chmod 600 .env
```

Abra o `.env` num editor de texto e preencha `DISCORD_TOKEN` e `DISCORD_CLIENT_ID`. Depois execute `npm run host:check` e `npm start`. Deixe esse terminal aberto enquanto estiver testando. O painel abre em [http://127.0.0.1:3210](http://127.0.0.1:3210) no próprio PC.

### Início automático no Linux

Use o modelo [sonora.service.example](../scripts/sonora.service.example) se a distribuição usar systemd. Copie para `~/.config/systemd/user/sonora.service` e ajuste `WorkingDirectory` para a pasta `sonora` e `ExecStart` para o caminho exibido por `command -v node`. Se o caminho contiver espaços, use aspas na unidade.

```bash
systemctl --user daemon-reload
systemctl --user enable --now sonora
systemctl --user status sonora
journalctl --user -u sonora -f
```

O serviço reinicia o bot se o processo sair. Para pará-lo e desativar o início automático, use `systemctl --user disable --now sonora`. Para iniciar ao ligar o computador, antes de entrar na conta, o administrador pode usar `sudo loginctl enable-linger NOME_DO_USUARIO`. Deixe a pasta do projeto e os arquivos de áudio em armazenamento montado na inicialização e configure o computador para permanecer acordado. Se armazenar a biblioteca em um disco separado, o modelo de serviço traz uma checagem opcional da montagem. [Serviços de usuário e linger no systemd](https://www.freedesktop.org/software/systemd/man/latest/loginctl.html)

## Celular Android com Termux

Use de preferência um **Android ARM64**. Instale [Termux](https://f-droid.org/en/packages/com.termux/) e, se quiser iniciar com o celular, [Termux:Boot](https://f-droid.org/en/packages/com.termux.boot/) da mesma origem. O Termux tem suporte a pacotes no Android 7 ou superior. A disponibilidade e a execução em segundo plano dependem do aparelho e da versão do Android. Não é um APK do Sonora: o bot roda dentro do Termux. [Instalação do Termux](https://github.com/termux/termux-app#installation)

1. Baixe `sonora-host.tar.gz` em **Assets** na [última versão](https://github.com/aaronmlf/sonora-discord-bot/releases/latest) e salve-o na pasta **Downloads** do celular. No Termux, execute:

   ```sh
   pkg update
   pkg install nodejs-lts npm ffmpeg termux-services
   termux-setup-storage
   cd "$HOME"
   tar -xzf "$HOME/storage/downloads/sonora-host.tar.gz"
   cd sonora
   npm ci --omit=dev --include=optional
   cp .env.example .env
   chmod 600 .env
   ```

   Aceite o acesso ao armazenamento quando o Android pedir para importar o pacote. O projeto executa dentro do diretório pessoal do Termux. Se já houver um `~/sonora` em uso, pare o bot e preserve a instalação e seus dados antes de extrair o pacote. Para links externos, use `pkg install python-yt-dlp yt-dlp-ejs`. [Pacotes Node.js do Termux](https://github.com/termux/termux-packages/blob/master/packages/nodejs-lts/build.sh) · [Pacote yt-dlp](https://github.com/termux/termux-packages/blob/master/packages/python-yt-dlp/build.sh)

2. Preencha o `.env` no Termux com o token e o ID da aplicação. Deixe `HOST=127.0.0.1`. Transfira seus áudios conforme necessário. Execute `npm run host:check` e `npm start` para o primeiro teste. Use a versão compilada do pacote no Termux. O compilador TypeScript usado no projeto roda no PC.

3. Encerre o teste com `Ctrl+C`. Reabra o Termux para iniciar o gerenciador de serviços recém-instalado. Em `~/sonora`, instale e habilite o serviço:

   ```sh
   cd "$HOME/sonora"
   mkdir -p "$PREFIX/var/service/sonora/log"
   touch "$PREFIX/var/service/sonora/down"
   install -m 700 scripts/termux/run "$PREFIX/var/service/sonora/run"
   ln -s "$PREFIX/share/termux-services/svlogger" "$PREFIX/var/service/sonora/log/run"
   termux-wake-lock
   sv-enable sonora
   sv status sonora
   ```

   O serviço procura o projeto em `~/sonora`. Consulte o log com `tail -f "$PREFIX/var/log/sv/sonora/current"`. Use `sv-disable sonora` para desativar, e `termux-wake-unlock` ao terminar, se o Termux não precisar mais manter a CPU acordada. [Documentação de termux-services](https://github.com/termux/termux-services)

4. Para iniciar depois de reiniciar o celular, abra o app **Termux:Boot** uma vez. Coloque o script preparado na pasta de inicialização:

   ```sh
   cd "$HOME/sonora"
   mkdir -p "$HOME/.termux/boot"
   install -m 700 scripts/termux/boot "$HOME/.termux/boot/sonora"
   ```

   Se o aparelho limitar a execução quando a tela apaga, verifique as opções de bateria do Termux e do Termux:Boot. Depois de reiniciar, desbloqueie o aparelho e confira `sv status sonora`. Teste com a tela apagada e depois de uma perda de Wi-Fi. O Android pode encerrar o processo mesmo com o serviço configurado. [Termux:Boot](https://github.com/termux/termux-boot#how-to-use) · [Android e execução em repouso](https://developer.android.com/training/monitoring-device-state/doze-standby)

## Controlar pelo Discord e acessar o painel

Os comandos do Discord funcionam para quem estiver no servidor mesmo que o painel fique local no host. Com `HOST=127.0.0.1`, o painel fica em `http://127.0.0.1:3210` no aparelho. Para acessar de outro computador, use um túnel privado, como encaminhamento local por SSH em uma máquina onde você já tenha acesso, ou o método opcional de [compartilhamento do painel](../README.md#acesso-remoto-ao-painel) em um host compatível. A instalação contínua mantém o painel local por padrão.
