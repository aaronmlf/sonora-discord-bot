# Hospedar o Sonora no Windows

Este guia é para Windows de 64 bits em processadores Intel/AMD (**x64**), preferencialmente Windows 11 atualizado. Não exige Docker, WSL, Git nem ferramentas de compilação. Você instalará as dependências e usará o pacote do Sonora já compilado.

O computador precisa ficar ligado, conectado à internet e sem suspender enquanto o bot estiver em uso. A interface abre no navegador; não é necessário manter o aplicativo do Discord aberto no computador que hospeda o bot.

## 1. Instalar Node.js e FFmpeg

Abra **Terminal** ou **Windows PowerShell** pelo menu Iniciar, na sua conta normal. Execute uma linha por vez:

```powershell
winget install --exact --id OpenJS.NodeJS.LTS --source winget --architecture x64
winget install --exact --id Gyan.FFmpeg --source winget --architecture x64
```

Leia e confirme as solicitações dos instaladores. O Windows pode pedir autorização de administrador para instalar o Node; o **bot não precisa ser executado como administrador**. Os identificadores estão no catálogo da Microsoft: [Node.js LTS](https://github.com/microsoft/winget-pkgs/tree/master/manifests/o/OpenJS/NodeJS/LTS) e [FFmpeg](https://github.com/microsoft/winget-pkgs/tree/master/manifests/g/Gyan/FFmpeg). [Como funciona `winget install`](https://learn.microsoft.com/en-us/windows/package-manager/winget/install)

Se `winget` não for reconhecido, instale/atualize o **Instalador de Aplicativo**, da Microsoft, pela Microsoft Store e reabra o terminal. Também é possível usar os instaladores abaixo. [Disponibilidade do WinGet](https://learn.microsoft.com/en-us/windows/package-manager/winget/)

### Alternativa sem WinGet

1. Baixe o **Windows Installer `.msi`, x64, LTS** no [site oficial do Node.js](https://nodejs.org/en/download). Mantenha npm e a adição ao `PATH` habilitados. O projeto exige Node **22.12 ou superior**; prefira uma versão LTS ainda mantida. Não é necessário marcar a instalação de ferramentas extras para compilar módulos nativos.
2. No [site oficial do FFmpeg](https://ffmpeg.org/download.html#build-windows), siga o link de builds Windows do Gyan. O FFmpeg publica o código-fonte e indica esses fornecedores de executáveis; não existe um instalador Windows produzido pelo próprio projeto.
3. Na página do [Gyan](https://www.gyan.dev/ffmpeg/builds/), baixe **`ffmpeg-release-essentials.zip`**, extraia e guarde em uma pasta permanente do seu usuário. Localize a subpasta `bin`: ela deve conter `ffmpeg.exe` e `ffprobe.exe`.
4. No menu Iniciar, procure **Editar as variáveis de ambiente da sua conta**. Em **Variáveis de usuário**, selecione `Path` → **Editar** → **Novo** e adicione o caminho completo dessa pasta `bin`. Não substitua nem apague as entradas existentes. Não adicione o caminho do ZIP nem o do arquivo `.exe` individual.

### Conferir a instalação

Feche o terminal e abra outro para carregar o `PATH` atualizado. Rode:

```powershell
node --version
node -p "process.platform + ' ' + process.arch"
npm.cmd --version
ffmpeg -version
ffprobe -version
```

O segundo comando deve mostrar `win32 x64`. Os demais devem mostrar versões, sem erro de comando não encontrado. Se não funcionarem, resolva essa etapa antes de continuar.

Neste guia usamos `npm.cmd`, que é o comando do npm para Windows. Isso evita o erro de execução de `npm.ps1` em instalações do PowerShell com política restritiva, sem precisar diminuir a proteção dos scripts do sistema.

## 2. Extrair o pacote pronto

1. Baixe **`sonora-host.zip`** na seção **Assets** da [última versão do Sonora](https://github.com/aaronmlf/sonora-discord-bot/releases/latest). O download automático **Source code (zip)** do GitHub não contém o código compilado.
2. Clique com o botão direito no arquivo → **Extrair Tudo**. Use uma pasta permanente que você possa modificar, por exemplo `%LOCALAPPDATA%\Sonora`. Não execute dentro do ZIP nem use `Program Files`, uma pasta compartilhada ou uma pasta sincronizada com a nuvem para guardar o `.env`.
3. Abra a pasta extraída **`sonora`**. Ela deve conter `package.json`, `.env.example`, `public`, `scripts` e **`dist\src\index.js`**.
4. Abra o PowerShell nessa pasta. Se usou o destino sugerido:

```powershell
Set-Location "$env:LOCALAPPDATA\Sonora\sonora"
Test-Path .\dist\src\index.js
npm.cmd ci --omit=dev --include=optional
```

O teste deve retornar `True`; o npm deve terminar sem erro. A instalação precisa de internet. Se extraiu para outro lugar, use `Set-Location "CAMINHO COMPLETO DA PASTA sonora"`.

Não copie `node_modules` de outro computador ou de Linux/Android. O npm instala os componentes corretos para este Windows, incluindo a criptografia de voz. Não use `--omit=optional`. Como o pacote já vem compilado, **não execute `npm run build` nem `npm run dev` nessa instalação de produção**.

## 3. Configurar o seu bot

Crie a aplicação e adicione o bot ao servidor seguindo [Preparação no Discord, no README](../README.md#preparação-no-discord). Depois, ainda na pasta do Sonora:

```powershell
if (-not (Test-Path -LiteralPath .env)) { Copy-Item .env.example .env }
notepad .env
```

O comando preserva um `.env` que já exista. No Bloco de Notas, preencha `DISCORD_TOKEN` com o **token do bot**, e `DISCORD_CLIENT_ID` com o **Application ID** do Developer Portal. `DISCORD_GUILD_ID` é opcional: preencha somente se quiser registrar os comandos apenas em um servidor de teste.

Para começar com acesso somente neste computador, mantenha:

```dotenv
HOST=127.0.0.1
PORT=3210
REMOTE_ACCESS_ENABLED=false
PUBLIC_URL=
ADMIN_TOKEN=
AUDIO_DIR=./data/audio
DATA_DIR=./data
```

Salve e feche o arquivo. Confirme pelo Explorador, com **Exibir → Mostrar → Extensões de nomes de arquivos**, que ele se chama `.env`, não `.env.txt`.

O token deve ficar somente no `.env` privado, nunca em capturas de tela, links, comandos de inicialização ou tarefas agendadas. Não compartilhe esse arquivo nem o envie ao GitHub. Se ele vazar, redefina o token no Developer Portal. Para disponibilizar a interface a outras pessoas, siga o [guia de acesso remoto do README](../README.md#acesso-remoto-ao-painel); não basta trocar `HOST` nem abrir uma porta no roteador.

## 4. Testar primeiro com um arquivo local

Na mesma pasta, execute:

```powershell
npm.cmd run host:check
npm.cmd start
```

Espere cada comando terminar antes do próximo; `npm.cmd start` ficará executando. O diagnóstico precisa aprovar configuração, FFmpeg, FFprobe, Opus, DAVE e AES-GCM. Um aviso apenas sobre `yt-dlp` não impede arquivos locais. O diagnóstico não faz login no Discord nem comprova a conexão de voz pela rede.

1. Abra [http://127.0.0.1:3210](http://127.0.0.1:3210) no navegador desse computador.
2. Confira se o painel indica que o bot está conectado ao Discord.
3. Pelo Discord, entre em um canal de voz e use **`/join` do seu bot**.
4. Na Biblioteca, use **Adicionar áudio**, escolha um MP3/WAV seu e adicione à fila. Você também pode copiar arquivos para `data\audio\music` e clicar em **Reindexar pasta**.
5. Verifique música, pausa, retomada e um efeito sobreposto. Faça esse teste antes de configurar a inicialização automática.

Deixe o terminal aberto enquanto usa essa execução manual. Para encerrar corretamente, pressione **Ctrl+C** e espere o comando terminar. Não abra duas instâncias usando a mesma pasta de dados. O áudio sai no canal do Discord, não nos alto-falantes do computador hospedeiro.

### Se não funcionar

| Sintoma | O que conferir |
| --- | --- |
| `npm.ps1` bloqueado | Use `npm.cmd`, como nos comandos acima. Não é necessário alterar a política do PowerShell. |
| `ffmpeg` ou `ffprobe` não encontrado | Reabra o terminal; confirme a pasta `bin` no `Path` do usuário. Ambos precisam estar acessíveis. |
| Erro DAVE/Opus ou módulo nativo ausente | Confirme `win32 x64`; pare o bot e rode novamente `npm.cmd ci --omit=dev --include=optional` neste computador. Não desative DAVE como solução. |
| `dist/src/index.js` não encontrado | Confirme a pasta atual e se recebeu o pacote **pré-compilado**, não apenas o código-fonte. |
| `TokenInvalid` | Corrija o token do bot no `.env`; ele não é o Application ID nem o Client Secret. Reinicie. |
| Porta já em uso / `EADDRINUSE` | Encerre a outra execução do Sonora, inclusive a tarefa agendada, antes de iniciar novamente. |
| Bot online, mas sem voz | Confira servidor/canal, permissões **Ver canais**, **Conectar**, **Falar** e o resultado de `/join`. VPNs, firewall ou rede corporativa podem bloquear a conexão de voz. Não desative a proteção do Windows inteira. |

## 5. YouTube/Spotify: opcional e experimental

A biblioteca local não precisa de `yt-dlp` e não muda com esta correção. Para o Sonora v0.1.1, use como base o **yt-dlp 2026.11.23**, ou uma versão estável mais recente, com EJS compatível. Atualizar o ZIP do Sonora não atualiza essa ferramenta; a instalação é opcional e manual. Pare o bot antes de trocar o executável.

Para uma primeira instalação pelo WinGet:

```powershell
winget install --exact --id yt-dlp.yt-dlp --source winget --architecture x64
```

Para atualizar uma instalação existente feita pelo WinGet:

```powershell
winget upgrade --exact --id yt-dlp.yt-dlp --source winget
```

Feche e reabra o terminal, volte à pasta do bot e confira:

```powershell
(Get-Command yt-dlp.exe).Source
yt-dlp --version
node --version
```

O pacote pode instalar dependências adicionais. Se o WinGet disser que não há atualização mas a versão continuar anterior a **2026.11.23**, use a alternativa oficial abaixo. [Instalação e atualização documentadas pelo yt-dlp](https://github.com/yt-dlp/yt-dlp/wiki/Installation#windows)

### Alternativa: executável oficial Windows x64

1. Na [release oficial 2026.11.23](https://github.com/yt-dlp/yt-dlp/releases/tag/2026.11.23), ou numa [release estável posterior](https://github.com/yt-dlp/yt-dlp/releases/latest), baixe **`yt-dlp.exe`**, o executável Windows x64. Não baixe `yt-dlp_linux`, a versão ARM64 nem o código-fonte para este procedimento.
2. Guarde-o numa pasta permanente da sua conta, por exemplo `%LOCALAPPDATA%\Sonora\tools`. Não substitua a cópia gerenciada pelo WinGet; se já houver um executável nesse destino, preserve a versão anterior antes de trocá-la.
3. Usando esse destino, confira a versão e obtenha o caminho completo no PowerShell:

   ```powershell
   & "$env:LOCALAPPDATA\Sonora\tools\yt-dlp.exe" --version
   (Get-Item "$env:LOCALAPPDATA\Sonora\tools\yt-dlp.exe").FullName
   ```

4. No `.env`, defina `YTDLP_PATH=` com **o caminho completo exibido**, sem escrever literalmente `%LOCALAPPDATA%` ou `$env:LOCALAPPDATA`: esses nomes não são expandidos no `.env` do Sonora. Não inclua `--version` nesse valor.

Para futuras atualizações **dessa cópia independente**, você pode baixar outra release oficial ou executar manualmente `& "$env:LOCALAPPDATA\Sonora\tools\yt-dlp.exe" -U`. Para a cópia gerenciada pelo WinGet, continue usando `winget upgrade`, evitando misturar os métodos. Se `YTDLP_PATH` estiver definido, a versão importante é a desse arquivo, mesmo que `yt-dlp --version` no terminal mostre outra.

### Node, EJS e teste depois da atualização

O Sonora habilita o mesmo Node que executa o bot para os desafios JavaScript do YouTube. O executável oficial `yt-dlp.exe` já inclui o componente EJS compatível; **não é necessário instalar Python ou EJS separadamente nessa opção**. Na versão 2026.11.23, a referência é EJS 0.8.0. Instalações Python diferentes precisam manter EJS no mesmo ambiente do yt-dlp. [Guia oficial de EJS](https://github.com/yt-dlp/yt-dlp/wiki/EJS)

Na pasta do projeto, execute `npm.cmd run host:check` e reinicie o bot, manualmente ou pelo Agendador, nunca nos dois ao mesmo tempo. Teste primeiro um arquivo local e depois um vídeo individual. O diagnóstico local não garante que o YouTube aceitará a conexão.

YouTube pode exigir autenticação, limitar downloads ou mudar seu serviço; nenhuma instalação garante que todo link tocará. Spotify fornece os dados para buscar uma faixa equivalente no YouTube, não seu áudio original. São aceitos links de faixas/vídeos individuais, não playlists completas. Não compartilhe cookies de autenticação; se forem necessários, guarde-os fora do repositório e dos pacotes distribuídos.

## 6. Não deixar o Windows suspender

No Windows 11, abra **Configurações → Sistema → Energia e bateria → Tela, suspensão e tempos limite de hibernação**. Os nomes podem variar conforme a versão. Enquanto hospeda, ajuste a **suspensão quando conectado à tomada** para **Nunca** e confira também a hibernação. A tela pode apagar normalmente. Em um notebook, mantenha ventilação, alimentação e a tampa aberta se fechá-la suspender o computador. [Configurações de energia da Microsoft](https://support.microsoft.com/en-us/windows/experience/power-battery/power-settings-in-windows-11)

O bot não continua tocando com o computador desligado, suspenso ou hibernando. Bloquear a tela com **Win+L** não é o mesmo que sair da conta; mantenha a sessão iniciada para o modo automático abaixo.

## 7. Iniciar ao entrar na sua conta: opcional

Configure isto **somente depois do teste manual funcionar**. Este modo inicia o Sonora após você entrar no Windows; não é um serviço que funciona antes do login. Não requer guardar a senha do Windows nem executar como `SYSTEM`. A modalidade interativa depende de uma sessão do usuário já iniciada. [Tipos de logon do Agendador](https://learn.microsoft.com/en-us/windows/win32/taskschd/principal-logontype)

Pare o teste manual com Ctrl+C. Na pasta do Sonora, anote os resultados destes comandos:

```powershell
(Get-Command node.exe).Source
(Get-Location).Path
```

1. Abra **Agendador de Tarefas** pelo menu Iniciar e selecione **Criar Tarefa**.
2. Em **Geral**, nomeie `Sonora`. Selecione a **sua conta atual**, marque **Executar somente quando o usuário estiver conectado** e deixe **Executar com privilégios mais altos** desmarcado.
3. Em **Disparadores → Novo**, escolha **Ao fazer logon**, **Usuário específico: sua conta**. Um atraso de **30 segundos** dá tempo para a rede iniciar. [Disparadores de logon](https://learn.microsoft.com/en-us/windows/win32/taskschd/starting-an-executable-when-a-user-logs-on)
4. Em **Ações → Nova → Iniciar um programa**, preencha:

   | Campo | Valor |
   | --- | --- |
   | **Programa/script** | Caminho completo de `node.exe` mostrado no primeiro comando. Use **Procurar** para selecioná-lo. |
   | **Adicionar argumentos** | `dist\src\index.js` |
   | **Iniciar em** | Caminho completo da pasta `sonora`, mostrado no segundo comando, **sem aspas**. |

   Não use `npm`, `start`, `.env` nem o token nesses campos. **Iniciar em** é essencial: é nessa pasta que o Sonora encontra `.env`, `public` e `data`. [Diretório de trabalho da ação](https://learn.microsoft.com/en-us/windows/win32/taskschd/execaction-workingdirectory)

5. Em **Condições**, não exija que o computador esteja ocioso. Para continuar mesmo se o notebook sair temporariamente da tomada, desmarque as opções de iniciar somente em alimentação elétrica e de parar ao passar para bateria; isso aumenta o consumo. Prefira deixá-lo conectado. [Condição de início na bateria](https://learn.microsoft.com/en-us/windows/win32/taskschd/tasksettings-disallowstartifonbatteries) e [interrupção ao passar para bateria](https://learn.microsoft.com/en-us/windows/win32/taskschd/tasksettings-stopifgoingonbatteries)
6. Em **Configurações**:
   - permita executar a tarefa sob demanda;
   - habilite reinício em caso de falha a cada **1 minuto**, por exemplo por **30 tentativas**; isso não substitui corrigir configuração inválida. [Tentativas de reinício](https://learn.microsoft.com/en-us/windows/win32/taskschd/tasksettings-restartcount)
   - **desmarque o limite de duração** “Interromper a tarefa se ela for executada por mais de…”; o padrão pode encerrar uma execução após 72 horas. [Limite de execução](https://learn.microsoft.com/en-us/windows/win32/taskschd/tasksettings-executiontimelimit)
   - se a tarefa já estiver em execução, escolha **Não iniciar uma nova instância**. [Política de instâncias](https://learn.microsoft.com/en-us/windows/win32/taskschd/tasksettings-multipleinstances)
7. Salve. Na biblioteca do Agendador, clique com o botão direito em **Sonora → Executar**. Abra o painel e repita o teste de voz. Por fim, reinicie o Windows, entre na mesma conta e verifique novamente.

O estado **Em execução** é esperado enquanto o bot está ligado. Uma janela de console pode aparecer; não a feche se quiser manter o bot ativo. Não rode `npm.cmd start` junto com a tarefa.

Se funcionar manualmente e não pelo Agendador, verifique a conta, os três campos da ação e o `PATH`: reinicie a sessão do Windows após instalar ferramentas. O histórico da tarefa ajuda a identificar falhas de inicialização; para ver os erros do Sonora, encerre a tarefa e execute manualmente na pasta correta. Nenhuma dessas etapas publica a interface na internet.

### Parar, desativar ou atualizar

Para impedir a próxima inicialização, use **Desabilitar** na tarefa. Isso não encerra a execução atual. Prefira Ctrl+C na janela do Sonora; se não houver janela, use **Finalizar** no Agendador, ciente de que é uma parada forçada e pode perder alterações em andamento.

Antes de atualizar, desabilite/pare a tarefa, confirme que o bot parou e faça backup privado de `.env` e `data`. Preserve a instalação anterior. Extraia a nova versão em outra pasta, transfira sua configuração/dados com o bot parado e rode `npm.cmd ci --omit=dev --include=optional` e `npm.cmd run host:check`. Ajuste **Iniciar em** na tarefa se o caminho mudar. Só reabilite após testar; nunca mantenha as duas versões usando os mesmos dados simultaneamente.

## Alcance da verificação

O diagnóstico local testa FFmpeg, Opus e DAVE. A automação do projeto verifica a instalação do ZIP e o painel num runner Windows x64. O Agendador, a rede e uma chamada de voz real ainda precisam ser testados no computador em que você vai hospedar o bot.
