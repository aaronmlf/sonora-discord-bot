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

### YouTube no Linux, incluindo Manjaro

Esta parte é opcional: músicas e efeitos locais não dependem de `yt-dlp`. Para a correção do Sonora v0.1.1, a base recomendada é **yt-dlp 2026.11.23** ou uma versão estável mais recente, acompanhada do EJS correspondente. O Sonora já habilita seu próprio Node para os desafios do YouTube, mas **Node não substitui EJS**. Nada é instalado ou atualizado automaticamente pelo bot.

Pare o Sonora antes da manutenção. Primeiro confira `yt-dlp --version` e `command -v yt-dlp`. Se já definiu `YTDLP_PATH`, execute `--version` no caminho indicado ali: atualizar outra cópia não terá efeito no bot.

#### Sem atualizar o sistema: executável oficial Linux x64

No Linux Intel/AMD x64 com glibc (como Manjaro x64), baixe **`yt-dlp_linux`** em [yt-dlp 2026.11.23](https://github.com/yt-dlp/yt-dlp/releases/tag/2026.11.23) ou numa [release estável posterior](https://github.com/yt-dlp/yt-dlp/releases/latest). Esse executável já inclui o EJS. Guarde-o em uma pasta permanente da sua conta, use `chmod +x yt-dlp_linux` e confira com `./yt-dlp_linux --version`. No `.env`, coloque o caminho absoluto desse arquivo em `YTDLP_PATH`. Assim você preserva o `yt-dlp` do sistema. Não use esse executável no Android. [Executáveis oficiais](https://github.com/yt-dlp/yt-dlp#release-files) · [EJS incluído](https://github.com/yt-dlp/yt-dlp/wiki/EJS#step-2-install-ejs-challenge-solver-scripts-yt-dlp-ejs)

#### Pacotes do Manjaro/Arch

```sh
sudo pacman -Syu yt-dlp yt-dlp-ejs
yt-dlp --version
```

Essa rota é opcional e também atualiza os demais pacotes do sistema; revise a operação antes de confirmar. Não use `pacman -Sy` isoladamente nem troque de branch somente para instalar o yt-dlp. Se a versão continuar anterior a 2026.11.23, ou o pacote EJS não estiver disponível na sua branch, use o executável oficial acima ou a alternativa Python abaixo. [Atualização de pacotes no Manjaro](https://wiki.manjaro.org/index.php?title=Pacman_Overview/en) · [Pacote e dependências do Arch](https://archlinux.org/packages/extra/any/yt-dlp/)

#### Alternativa oficial em ambiente Python separado

Esta opção serve também para outras distribuições com um pacote atrasado. É uma instalação do projeto oficial pelo PyPI, dentro de um **venv dedicado**, sem substituir `/usr/bin/yt-dlp` nem os pacotes Python do sistema.

Confirme **Python 3.11 ou superior** com `python3 --version`. No Debian/Ubuntu, o módulo de ambientes virtuais pode exigir `sudo apt install python3-venv`. No Manjaro, se faltar Python, instale-o como parte da atualização completa com `sudo pacman -Syu python`. Crie uma pasta nova para este ambiente, ou reutilize apenas um ambiente que você já tenha criado para o yt-dlp do Sonora:

```sh
python3 -m venv "$HOME/.local/share/sonora-tools/yt-dlp"
"$HOME/.local/share/sonora-tools/yt-dlp/bin/python" -m pip install --upgrade "yt-dlp[default]==2026.11.23"
"$HOME/.local/share/sonora-tools/yt-dlp/bin/yt-dlp" --version
"$HOME/.local/share/sonora-tools/yt-dlp/bin/python" -c "from importlib.metadata import version; print('EJS:', version('yt-dlp-ejs'))"
```

O resultado esperado desse conjunto é `2026.11.23` e `EJS: 0.8.0`. O grupo `[default]` instala as dependências compatíveis, inclusive EJS; não é necessário ativar o venv nem instalar o pacote `ffmpeg` do PyPI. FFmpeg/FFprobe continuam sendo os executáveis já instalados no sistema. [Instalação oficial do yt-dlp pelo PyPI](https://github.com/yt-dlp/yt-dlp/wiki/Installation#with-pip) · [Ambientes virtuais do Python](https://docs.python.org/3/library/venv.html)

Exiba o caminho para copiar:

```sh
printf '%s\n' "$HOME/.local/share/sonora-tools/yt-dlp/bin/yt-dlp"
```

No `.env`, defina `YTDLP_PATH=` com **esse caminho absoluto completo**. Não escreva literalmente `$HOME` ou `~`: o Sonora não expande essas variáveis no valor. Isso também permite que o serviço systemd encontre a cópia correta sem depender do `PATH` do terminal. Nunca use `sudo pip`, `--break-system-packages` nem `yt-dlp -U` para sobrescrever uma instalação gerenciada pela distribuição.

Para adotar futuras versões estáveis nessa instalação separada, execute manualmente `"$HOME/.local/share/sonora-tools/yt-dlp/bin/python" -m pip install --upgrade "yt-dlp[default]"` e confira novamente as versões. Reinicie o Sonora, rode `npm run host:check` na pasta do projeto e teste um vídeo individual autorizado. A versão de referência não garante funcionamento permanente: bloqueios de rede e mudanças do YouTube continuam possíveis.

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

   Aceite o acesso ao armazenamento quando o Android pedir para importar o pacote. O projeto executa dentro do diretório pessoal do Termux. Se já houver um `~/sonora` em uso, pare o bot e preserve a instalação e seus dados antes de extrair o pacote. Para links externos, siga [Atualizar YouTube no Termux](#atualizar-youtube-no-termux): o pacote do repositório pode estar atrasado. [Pacotes Node.js do Termux](https://github.com/termux/termux-packages/blob/master/packages/nodejs-lts/build.sh)

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

### Atualizar YouTube no Termux

Use esta seção no **Android ARM64 com o Python/Node do Termux**, não no PowerShell nem num Linux instalado por proot. A base recomendada para esta correção é **yt-dlp 2026.11.23 com EJS 0.8.0**. Arquivos locais não exigem essa atualização.

Pare a execução manual com Ctrl+C; se já usa o serviço deste guia, use `sv down sonora`. Atualize primeiro pelos pacotes do Termux:

```sh
pkg update
pkg upgrade
pkg install python-yt-dlp yt-dlp-ejs
yt-dlp --version
node --version
```

Revise os pacotes antes de confirmar: `pkg upgrade` atualiza o ambiente do Termux. Os nomes são **`python-yt-dlp`** e **`yt-dlp-ejs`**. Se houver uma versão recente e compatível, mantenha `YTDLP_PATH=yt-dlp`. Na consulta para esta correção, a [receita oficial do Termux](https://github.com/termux/termux-packages/blob/master/packages/python-yt-dlp/build.sh) ainda indicava **2026.10.26**, então atualizar o repositório podia não bastar; sempre confira a versão obtida no aparelho.

#### Se o pacote do Termux continuar antigo

Crie um ambiente privado com o **Python do próprio Termux**. Os dois pacotes abaixo possuem wheels Python independentes de arquitetura. O conjunto mínimo evita compilar dependências opcionais de outros sites e não altera os pacotes instalados por `pkg`:

```sh
pkg install python python-pip python-ensurepip-wheels
python --version
python -m venv "$HOME/.local/share/sonora-tools/yt-dlp"
"$HOME/.local/share/sonora-tools/yt-dlp/bin/python" -m pip install --upgrade --only-binary=:all: "yt-dlp==2026.11.23" "yt-dlp-ejs==0.8.0"
"$HOME/.local/share/sonora-tools/yt-dlp/bin/yt-dlp" --version
"$HOME/.local/share/sonora-tools/yt-dlp/bin/python" -c "from importlib.metadata import version; print('EJS:', version('yt-dlp-ejs'))"
printf '%s\n' "$HOME/.local/share/sonora-tools/yt-dlp/bin/yt-dlp"
```

Exija Python **3.11 ou superior** e resultados `2026.11.23` / `EJS: 0.8.0`; não prossiga se algum comando falhar. Essa combinação corresponde aos [requisitos da versão oficial](https://github.com/yt-dlp/yt-dlp/blob/2026.11.23/pyproject.toml), com [yt-dlp](https://pypi.org/project/yt-dlp/2026.11.23/) e [EJS](https://pypi.org/project/yt-dlp-ejs/0.8.0/) instalados no mesmo ambiente. É uma instalação mínima: recursos opcionais para outros sites podem não estar disponíveis. O Node e o FFmpeg já instalados continuam necessários; o Sonora seleciona o Node explicitamente.

Copie o caminho da última linha para `YTDLP_PATH=` no `.env`, por extenso, sem `$HOME` ou `~`. Não mova esse venv para o armazenamento compartilhado nem copie um venv do PC. Se uma atualização do Python do Termux quebrar o ambiente, crie outro venv com o Python atualizado e ajuste o caminho, preservando seus dados do Sonora.

**Não use `yt-dlp_linux` nem `yt-dlp_linux_aarch64` no Termux nativo**: esses executáveis são para Linux com glibc, não para o Android. Também não substitua o Python/pip do Termux com `sudo pip` ou `pip install --upgrade pip` global. Para atualizações futuras desta rota mínima, atualize o yt-dlp e o EJS juntos, com as versões correspondentes da [documentação oficial](https://github.com/yt-dlp/yt-dlp/wiki/EJS). [Plataformas dos executáveis oficiais](https://github.com/yt-dlp/yt-dlp#release-files)

Na pasta `~/sonora`, rode `npm run host:check` e inicie novamente com `npm start`, ou `sv up sonora` se usava o serviço; escolha apenas um modo. Teste uma faixa local e depois um link individual. Os comandos foram conferidos com os pacotes e fontes oficiais, mas a instalação e a reprodução precisam ser validadas no seu aparelho. O bot não executa essas instalações por conta própria.

## Controlar pelo Discord e acessar o painel

Os comandos do Discord funcionam para quem estiver no servidor mesmo que o painel fique local no host. Com `HOST=127.0.0.1`, o painel fica em `http://127.0.0.1:3210` no aparelho. Para acessar de outro computador, use um túnel privado, como encaminhamento local por SSH em uma máquina onde você já tenha acesso, ou o método opcional de [compartilhamento do painel](../README.md#acesso-remoto-ao-painel) em um host compatível. A instalação contínua mantém o painel local por padrão.
