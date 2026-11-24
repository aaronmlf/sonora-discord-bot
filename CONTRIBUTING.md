# Contribuindo com o Sonora

Use Node.js 22.12 ou superior, npm e FFmpeg/FFprobe disponíveis no `PATH`. Trabalhe em uma cópia de desenvolvimento, sem apontar os testes para sua biblioteca de produção.

## Antes de enviar uma mudança

```bash
npm ci --include=dev --include=optional
npm run typecheck
npm test
npm run build
DOTENV_CONFIG_PATH=/dev/null npm run host:check
```

Os testes usam dados temporários e não precisam de token do Discord, cookies ou músicas pessoais. O diagnóstico verifica decodificação, Opus e DAVE localmente; avisos sobre credenciais ausentes ou `yt-dlp` não instalado são esperados quando esses recursos não foram configurados.

A CI executa essas verificações em Linux com Node 22 e FFmpeg, em pushes e pull requests. Ela não publica pacotes, não inicia o bot e não comprova reprodução em uma chamada real nem disponibilidade de links externos.

## Mudanças e correções

- Explique o problema, como reproduzi-lo e como verificou a correção.
- Acrescente um teste de regressão quando corrigir um bug. Prefira arquivos de áudio gerados nos testes e serviços simulados.
- Em mudanças visuais, confira desktop e celular, teclado, estado sem conexão e perfis de anfitrião/convidado. Inclua imagens sem informações privadas quando forem úteis.
- Preserve compatibilidade com bibliotecas, playlists e configurações existentes. Documente migrações e mudanças na hospedagem.

## Dados privados

Nunca envie `.env`, tokens, cookies, convites de acesso, conteúdo de `data/`, backups ou áudios pessoais no commit, em imagens ou em registros de erro. Use `.env.example` para documentar configurações sem segredos.

Para investigar reprodução real, utilize seu próprio bot e um servidor de teste. Informe versões do Node, sistema operacional e FFmpeg, o comportamento esperado e o resultado observado. Remova dados privados dos registros antes de compartilhá-los.
