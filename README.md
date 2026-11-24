# Sonora

Bot de áudio self-hosted para Discord com uma biblioteca de arquivos pessoais e um painel web local. Inclui comandos nativos, fila independente por servidor, pausa, avanço, volume, repetição, upload de áudio, links externos experimentais e efeitos sonoros sobrepostos à música.

Você pode criar seu próprio bot no Discord e rodar o Sonora com ele. Se quiser deixar o bot disponível sem manter seu computador principal ligado, use um [PC Linux antigo ou um celular Android com Termux](docs/host.md).

## Requisitos

- Node.js 22.12 ou mais recente
- FFmpeg e FFprobe disponíveis no sistema
- `yt-dlp` disponível no sistema para o modo experimental de YouTube/Spotify
- Uma aplicação de bot criada no [Discord Developer Portal](https://discord.com/developers/applications)

Não é necessário Docker. Para rodar continuamente em outro computador ou experimentar em um celular Android, veja o [guia de hospedagem](docs/host.md).

## Preparação no Discord

1. Crie uma aplicação no [Discord Developer Portal](https://discord.com/developers/applications). Em **Informações gerais**, copie o ID da aplicação (`DISCORD_CLIENT_ID`).
2. Em **Bot → Redefinir token**, gere e copie o token (`DISCORD_TOKEN`). Guarde-o somente no `.env` do seu host; não o envie a ninguém nem o publique no GitHub.
3. Em **Instalação**, ative **Instalação de guilda** e selecione **Link fornecido pelo Discord**. Instalação de usuário não é necessária para o Sonora.
4. Nas configurações padrão de **Instalação de guilda**, adicione os escopos `bot` e `applications.commands`. Para o bot, selecione **Ver canais**, **Enviar mensagens**, **Conectar** e **Falar**. Não é necessário dar permissão de administrador ao bot.
5. Salve as alterações, abra o link gerado e escolha **Adicionar ao servidor**. A conta que autoriza a instalação precisa da permissão **Gerenciar servidor**.

O Sonora usa comandos `/`, portanto não precisa da permissão privilegiada de leitura do conteúdo das mensagens. Veja também o [guia oficial de configuração de bots do Discord](https://docs.discord.com/developers/quick-start/getting-started).

## Instalação

```bash
git clone https://github.com/aaronmlf/sonora-discord-bot.git
cd sonora-discord-bot
npm ci
cp .env.example .env
```

Preencha no arquivo `.env`:

```dotenv
DISCORD_TOKEN=token_do_bot
DISCORD_CLIENT_ID=id_da_aplicacao
DISCORD_GUILD_ID=id_do_servidor_de_teste
```

`DISCORD_GUILD_ID` é opcional, mas recomendado durante o desenvolvimento: os comandos aparecem imediatamente somente nesse servidor. Sem ele, os comandos são registrados globalmente e podem demorar para aparecer.

Inicie em modo de desenvolvimento:

```bash
npm run dev
```

Ou gere e execute a versão compilada:

```bash
npm run build
npm start
```

Abra [http://127.0.0.1:3210](http://127.0.0.1:3210) na máquina que hospeda o bot.

Entre em um canal de voz no Discord e use `/join`. No painel, adicione um arquivo de áudio na Biblioteca e envie-o para a fila para testar a reprodução.

## Biblioteca de áudio

Há duas formas de cadastrar áudio:

- Use **Adicionar áudio** ou **Adicionar efeito** no painel.
- Copie arquivos para `data/audio/music` ou `data/audio/effects` e clique em **Reindexar pasta**.

As duas pastas aceitam subpastas em qualquer profundidade. A Biblioteca e a soundboard mostram primeiro as pastas disponíveis; clique em uma delas para ver seus áudios. Dentro de uma pasta, **Tocar todas** adiciona seu conteúdo e o de suas subpastas à fila, enquanto **Shuffle** adiciona os mesmos itens em ordem aleatória. Arquivos soltos aparecem na pasta virtual **Sem pasta**.

Use **Nova pasta** e **Mais → Mover para pasta** para organizar os arquivos sem perder seus identificadores, edições ou playlists. Movimentos feitos fora do painel são reconhecidos pelo conteúdo somente quando a correspondência é única; o bot não tenta adivinhar entre cópias idênticas.

Formatos aceitos: MP3, FLAC, WAV, OGG, Opus, M4A, AAC e WebM. O FFprobe valida cada arquivo e lê título, artista, álbum e duração quando esses metadados existem.

Cada item da Biblioteca e de Efeitos possui ações próprias para:

- editar título, artista, álbum e tipo;
- adicionar o áudio a uma playlist local;
- mover somente aquele arquivo para a lixeira, mesmo quando há cópias com o mesmo nome;
- marcar favoritos, editar etiquetas, ouvir uma prévia apenas no navegador, tocar agora ou adicionar como próxima.

As abas **Biblioteca** e **Efeitos** também podem ser filtradas por playlist. Ao escolher uma coleção, cada aba mostra somente os itens daquele tipo que pertencem à playlist selecionada.

A exclusão move o arquivo para `data/audio/.trash` e o retira das filas ativas. Em **Mesa RPG → Lixeira e duplicados**, é possível restaurá-lo, incluindo sua participação nas playlists. Somente o anfitrião pode esvaziar a lixeira permanentemente, com confirmação. Os metadados editados ficam salvos em `data/library.json` e continuam valendo depois de reindexar a pasta.

Ambas as bibliotecas têm filtros de favoritos e etiquetas, ordenação por nome/duração/data e busca textual (também em Efeitos). Os filtros se combinam com a playlist selecionada. **Adicionar áudio** aceita vários arquivos de uma vez e envia para a pasta aberta, com resultado individual. **Tocar todas** e **Shuffle** respeitam os filtros e incluem subpastas; adicionam à fila sem substituir a música atual.

Os duplicados são agrupados pelo SHA-256 do arquivo completo (inclusive quando os nomes diferem). Arquivos com tags embutidas diferentes podem ter hashes diferentes mesmo contendo o mesmo som. Nenhuma cópia é apagada automaticamente. A primeira indexação desta versão precisa ler o conteúdo dos arquivos para calcular os hashes e pode levar mais tempo.

## Playlists locais

Na aba **Playlists**, crie coleções persistentes com qualquer combinação de músicas e efeitos locais. É possível repetir itens, mudar a ordem, remover itens sem apagar os arquivos e enviar a playlist inteira para a fila do servidor ativo.

Ao tocar uma playlist, seus itens entram na fila na ordem definida. Para sobrepor um efeito à música atual, continue usando a aba **Efeitos** ou o comando `/effect`.

## Comandos

- `/play <audio>` — entra no canal do usuário e toca ou adiciona o item à fila.
- `/play <link>` — aceita vídeos do YouTube e faixas do Spotify.
- `/effect <audio>` — dispara um efeito sobre a música, sem interrompê-la.
- `/join` — entra no canal de voz do usuário.
- `/pause` e `/resume` — pausa e retoma.
- `/skip` — pula o item atual.
- `/stop` — para e limpa a fila.
- `/queue` — mostra os próximos itens.
- `/loop off|track|queue` — controla a repetição.
- `/volume <0-100>` — altera o volume.
- `/leave` — limpa a fila e sai do canal.

Para controlar a reprodução por comandos, o usuário precisa estar no mesmo canal de voz do bot. O painel do host controla qualquer sessão ativa.

Na fila do painel, clique no título de uma faixa pendente para tocá-la imediatamente. As faixas que estavam antes dela são consideradas puladas e retiradas da fila.

As ações do painel usam identificadores próprios de cada entrada, inclusive quando uma música aparece repetida, evitando agir sobre outra faixa quando alguém modifica a fila ao mesmo tempo. **Embaralhar próximas** não altera a música atual; **Salvar fila como playlist** inclui a música atual e as próximas, e exige uma fila composta por arquivos locais disponíveis.

Filas e ajustes de volume/repetição ficam em `data/sessions.json`. Após reiniciar, o painel oferece **Restaurar** ou **Descartar**. Para restaurar, chame primeiro o bot pelo Discord. Não há entrada automática em call; a faixa atual recomeça do início e arquivos locais indisponíveis são ignorados. Ambientes e efeitos em andamento não são retomados automaticamente: ative novamente sua cena.

## Mesa RPG — cenas e três grupos de áudio

A aba **Mesa RPG** permite salvar cenas com nome, playlist musical opcional, até três ambientes locais em loop, volumes individuais e efeitos favoritos. As cenas ficam em `data/scenes.json` e são compartilhadas entre as pessoas que têm acesso ao painel. A ativação se aplica somente ao servidor selecionado.

- Música, ambientes e efeitos têm volumes separados. Ambientes também têm controle individual de volume e parada.
- Pausar/retomar afeta somente a música: ambientes e efeitos continuam. Efeitos funcionam mesmo sem música e até oito podem tocar simultaneamente.
- Ativar uma cena substitui música/ambientes com transição de dois segundos por padrão (ajustável de zero a dez), mantendo efeitos em andamento. Se um arquivo/playlist da cena estiver ausente, a ativação é recusada para você corrigir a cena.
- A redução automática de música durante efeitos é opcional e começa desligada. **Parar todos os efeitos** não interrompe música ou ambientes. O controle geral **Parar** encerra todos os grupos.
- **Mais → Configurar atalho** em um efeito permite atribuir A–Z ou 0–9. Os atalhos são locais ao navegador, funcionam nas abas Efeitos/Mesa RPG e ficam desativados em campos de texto, seletores e janelas de edição.
- **Modo apresentação** amplia a soundboard; Escape ou o botão de saída retorna à interface normal.
- **Ouvir só aqui** toca no navegador de quem clicou, nunca no Discord. O suporte a formatos depende do navegador; use MP3/WAV se a prévia de outro formato não abrir.

Os novos controles preservam a autenticação do painel e a proteção das operações por sessão. Não é necessário Docker nem serviço externo adicional.

### Backup e atualização

Ao abrir um catálogo antigo, a migração cria `data/library.json.pre-v3-<data>.bak` antes da primeira gravação no formato novo. Use uma instância por pasta de dados.

Para atualizar, encerre a instância anterior, execute `npm run build` e depois `npm start`. Recarregue o navegador. Para voltar à versão anterior, pare o bot, preserve uma cópia de `data`, extraia o backup do código e restaure o catálogo pré-migração correspondente. Arquivos movidos/restaurados/excluídos depois da atualização não são revertidos pelo backup de código; restaure os arquivos necessários pela lixeira antes de voltar.

## YouTube e Spotify — modo experimental

Links do YouTube são transmitidos por `yt-dlp` e FFmpeg sem criar arquivos permanentes. Links do Spotify são consultados pelo oEmbed oficial para obter o título e então convertidos em uma busca equivalente no YouTube.

Atualmente são aceitos vídeos individuais do YouTube e faixas individuais do Spotify. Playlists, álbuns, podcasts e transmissões ao vivo são recusados.

Caso o YouTube exija autenticação no ambiente de hospedagem, exporte cookies válidos para um arquivo e configure:

```dotenv
YTDLP_COOKIES_FILE=/caminho/seguro/cookies.txt
```

Essa integração não é oficial e pode parar de funcionar quando as plataformas alterarem seus serviços. O responsável pela hospedagem deve garantir que possui autorização para reproduzir o conteúdo utilizado.

## Efeitos sem interrupção

Os efeitos da soundboard são decodificados separadamente e misturados à faixa atual em tempo real. Eles não pausam, reiniciam, pulam nem alteram a posição da música. Música e efeitos possuem volumes independentes; até oito efeitos podem tocar simultaneamente.

## Acesso remoto ao painel

Por padrão, o painel continua acessível somente em `127.0.0.1`. O modo remoto recomendado usa [Tailscale Funnel](https://tailscale.com/docs/features/tailscale-funnel): ele fornece uma URL pública HTTPS sem abrir a porta do Sonora diretamente no roteador.

1. Instale o Tailscale, entre na sua conta e habilite o Funnel para a máquina.
2. Descubra a URL HTTPS que será usada:

```bash
npm run remote:status
```

3. Gere um token exclusivo para o painel. Não reutilize o token do Discord:

```bash
openssl rand -hex 32
```

4. Configure o `.env`, mantendo o servidor preso ao computador local:

```dotenv
HOST=127.0.0.1
ADMIN_TOKEN=cole_aqui_o_token_gerado
REMOTE_ACCESS_ENABLED=true
PUBLIC_URL=https://nome-da-maquina.seu-tailnet.ts.net
```

5. Inicie o Sonora e, em outro terminal, publique o painel:

```bash
npm start
npm run remote:start
```

Entre como anfitrião usando o `ADMIN_TOKEN`. A aba **Compartilhar** permite criar um link individual. Cada convite funciona somente uma vez, expira em 24 horas e cria uma sessão persistente naquele navegador. A pessoa convidada pode controlar reprodução, biblioteca, efeitos e playlists, mas não pode criar outros convites nem gerenciar acessos.

Para encerrar um acesso específico, use **Revogar** na aba **Compartilhar**. Para desligar toda a URL pública:

```bash
npm run remote:stop
```

Os tokens de sessão e convite são armazenados apenas como hashes em `data/access.json`; a sessão usa cookie protegido e as alterações exigem uma proteção adicional contra requisições forjadas. Mesmo assim, trate qualquer link de convite como uma credencial e envie-o somente à pessoa correta.

## Verificações

### Conexão, diagnóstico e cores

O login inicial é repetido após falhas transitórias, com intervalos de 2 a 60 segundos. Um token inválido interrompe as tentativas: corrija a configuração e reinicie. O painel mostra o estado da conexão e a próxima tentativa.

Em **Preferências**, personalize destaque, fundo, painéis e textos. As cores são salvas por navegador e podem ser restauradas pelo botão **Restaurar cores originais**. O diagnóstico de conexão, comandos e ferramentas é exclusivo do anfitrião. A indexação inicia em segundo plano e apresenta progresso e arquivos com problemas nessa mesma aba.

### Diagnóstico de um novo aparelho

Depois de compilar ou extrair o pacote para outro host, execute `npm run host:check` para testar FFmpeg, FFprobe, Opus e DAVE na máquina. O início automático no [PC Linux ou Android](docs/host.md) é opcional.

```bash
npm run typecheck
npm test
npm run build
```

## Compartilhamento, histórico e backups

Em **Compartilhar**, o anfitrião escolhe o perfil de cada convite e pode limitar o acesso aos IDs dos servidores desejados:

- **Controle completo:** reprodução, efeitos e ambientes. A edição da biblioteca, playlists e cenas compartilhadas exige acesso sem restrição de servidores, pois esses arquivos são globais.
- **Somente reprodução:** fila e controles da música. Parar a música preserva efeitos e ambientes.
- **Somente efeitos:** disparar efeitos, ajustar seu volume e interrompê-los, sem controlar a música ou ambientes.

Gerenciar acessos, diagnóstico e backups continua exclusivo do anfitrião. Convites anteriores mantêm controle completo em todos os servidores até serem editados. Alterar permissões ou revogar acesso encerra a atualização ao vivo da sessão; logout e expiração também limpam o painel. Sessões do anfitrião expiram em 12 horas; as de convidados persistem até logout ou revogação. As restrições são verificadas no servidor, não apenas nos botões.

O Player mostra até 100 ações recentes com o nome de quem as executou. Esse histórico fica em memória e é limpo ao reiniciar; convidados só veem ações dos servidores permitidos.

Em **Preferências**, o anfitrião pode baixar um arquivo `.sonora.gz`. Por padrão ele contém metadados da biblioteca, playlists, cenas e filas salvas; a opção de incluir áudio acrescenta os arquivos locais, inclusive os da lixeira. Credenciais, `.env`, convites e sessões de acesso não são exportados.

Restaurar substitui os metadados atuais e desconecta os players, sem reconectá-los automaticamente. O arquivo é validado antes da aplicação. O limite `MAX_UPLOAD_MB` também se aplica ao conteúdo descompactado, incluindo a representação base64 dos áudios. Antes da alteração, uma cópia dos metadados atuais é salva em `data/backups/antes-restauracao-*.sonora.gz`. Áudios sobrescritos são preservados separadamente nessa pasta, com um manifesto `.files.json` para recuperação manual; restaurar apenas essa cópia de metadados não repõe esses áudios automaticamente. Os acessos existentes não são modificados pela restauração.

A interface móvel inclui controles de toque maiores, navegação compacta e saída da sessão visível.

## Limitações atuais

- Filas salvas podem ser recuperadas após reiniciar, mas o bot não reconecta à chamada automaticamente.
- Playlists do YouTube/Spotify ainda não são importadas em lote.
- A correspondência de um link do Spotify depende do primeiro resultado encontrado no YouTube.

## Quando o bot não entra na chamada ou não toca

1. Após alterar o código, execute `npm run build` e reinicie com `npm start`. O terminal deve permanecer aberto. A interface mostra um aviso se o bot estiver desconectado ou fora da chamada.
2. Entre em um canal de voz e use o comando **`/join` do seu bot**. Ele precisa de **Ver canais**, **Conectar** e **Falar**, inclusive nas permissões específicas do canal. Erros de conexão são respondidos no próprio comando.
3. Selecione o servidor correto no painel, abra uma pasta e use **+ Fila** ou **Tocar todas**. Esses controles ficam desabilitados antes de o bot entrar na call. Convites com perfil “somente efeitos” não oferecem controle da fila musical.
4. Se reorganizou arquivos, use **Reindexar pasta**. A reindexação atualiza também os caminhos das faixas já na fila. Os áudios não são movidos nem apagados por essa operação.
5. **Carregando áudio** significa que ainda não chegaram dados para reprodução. A fonte é interrompida com erro se não iniciar em 45 segundos ou deixar de enviar áudio por 30 segundos; pausas voluntárias não contam nesse limite. Uma faixa que falha não fica presa no loop: a fila segue para a próxima.

YouTube é experimental e pode impor bloqueios ou limites por conexão. O bot utiliza o Node instalado para os desafios JavaScript do yt-dlp; mantenha yt-dlp e seu componente EJS atualizados conforme a [documentação oficial](https://github.com/yt-dlp/yt-dlp/wiki/EJS). Nenhuma configuração contorna garantidamente os bloqueios da plataforma. Spotify identifica a faixa e busca um equivalente no YouTube, não reproduz o stream do Spotify.

Uma perda de conexão de voz pausa a reprodução e preserva a fila. Se ela não se recuperar em 20 segundos, use `/join` novamente. A mensagem do painel diferencia isso de erro no arquivo ou download. O diagnóstico em **Preferências** verifica a comunicação e as ferramentas necessárias.

## Publicação do projeto

O [guia de publicação no GitHub](docs/github.md) explica como gerar e publicar uma cópia limpa do código com `npm run public:pack`. O `npm run host:pack` gera o pacote compilado para instalar em outro aparelho.
