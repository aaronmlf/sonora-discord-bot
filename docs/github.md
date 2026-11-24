# Preparar o Sonora para o GitHub

Use a cópia pública gerada com `npm run public:pack`. Ela fica em `release/sonora-public.tar.gz` e tem somente arquivos do projeto para publicação. Para rodar o Sonora em outro aparelho, use o pacote separado `sonora-host.tar.gz`.

## Publicar o código

1. Extraia `sonora-public.tar.gz` em uma pasta nova e entre na pasta `sonora` que foi extraída. Ela é a raiz do futuro repositório.
2. Confira os arquivos e faça o primeiro commit:

   ```sh
   git init -b main
   git add .
   git diff --cached --stat
   git commit -m "Versão inicial do Sonora"
   ```

   A lista deve incluir `.env.example`. Bibliotecas pessoais, `.env`, `data/`, credenciais, convites e arquivos compilados ficam fora.

3. Crie um repositório **Public** vazio no GitHub, por exemplo `sonora-discord-bot`. Copie a URL que aparecer na página **Quick Setup** e use-a em `git remote add origin`:

   ```sh
   git remote add origin https://github.com/SEU-USUARIO/sonora-discord-bot.git
   git push -u origin main
   ```

O repositório contém um workflow de integração contínua para as verificações do Sonora. Cada pessoa que instalar o bot configura sua própria aplicação do Discord e seu próprio `.env`. [Guia do GitHub para importar código local](https://docs.github.com/en/migrations/importing-source-code/using-the-command-line-to-import-source-code/adding-locally-hosted-code-to-github)

## Licença

Se quiser conceder permissão para que outras pessoas reutilizem e redistribuam o código, escolha uma licença e adicione um arquivo `LICENSE` antes de publicar. A visibilidade pública do repositório por si só permite ver e fazer fork pelo GitHub, e a licença define permissões adicionais de uso. [Licenciamento de repositórios no GitHub](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/licensing-a-repository)
