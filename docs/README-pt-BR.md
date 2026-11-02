# MCP Crunchyroll — apresentação em português

Servidor não oficial de Model Context Protocol (MCP) para pesquisar o catálogo da Crunchyroll e consultar informações da sua conta usando um cliente MCP.

## O que é possível fazer

- Pesquisar animes e consultar séries, temporadas e episódios.
- Consultar histórico, lista de acompanhamento e recomendações.
- Adicionar ou remover títulos da lista e atualizar o progresso.

A versão 0.1.0 publica 21 ferramentas; 19 estão operacionais. As ferramentas de continuar assistindo e consultar assinatura ainda estão desativadas. O servidor **não reproduz vídeos**, não baixa mídia e não contorna DRM.

## Instalação

Você precisa do Node.js 18 ou mais recente, npm e um navegador da família Chromium compatível.

```bash
git clone https://github.com/Itthiago034/mcp-crunchyroll.git
cd mcp-crunchyroll
npm ci
npm run typecheck
npm run build
```

Configure seu cliente MCP para executar `node` com o caminho absoluto para `dist/index.js`. O [README principal](../README.md) traz um exemplo de configuração e a lista de ferramentas. Há também um `manifest.yaml` para instalações compatíveis do Hermes; a configuração pode variar conforme a versão.

Chame `crunchyroll_login({})` e entre na sua conta na janela do navegador gerenciado. Depois, consulte `crunchyroll_status({})`. O login é interativo: não passe senha, cookies ou tokens como argumentos ao MCP.

## Exemplos de pedidos ao cliente

- “Procure Frieren na Crunchyroll.”
- “Mostre as temporadas e os episódios desta série.”
- “Quais animes assisti recentemente?”
- “Mostre minha lista de acompanhamento.”

Os resultados dependem da conta, da região, do cliente e da disponibilidade do serviço. As interfaces web internas da Crunchyroll podem mudar.

Projeto da comunidade, sem afiliação ou endosso da Crunchyroll. Baseado no projeto de código aberto `@striderlabs/mcp-crunchyroll`; licença MIT.
