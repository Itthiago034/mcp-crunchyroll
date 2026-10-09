# Validação com navegador real e várias requisições

Execução em Chromium 151.0.7922.173 com sandbox nativo habilitado e Node.js
24.19.0. Os resultados são observações desta máquina, não uma estimativa de
capacidade do Crunchyroll em produção.

## Carga controlada

O teste `test/browser-load.test.ts` inicia um navegador real com perfil
temporário, navega para um servidor HTTP/1.1 local e chama a função congelada
de produção `CRUNCHYROLL_FETCH_FUNCTION` por CDP, com argumentos estruturados.
Não há mock de `fetch`, `Response`, stream ou socket. A origem de produção
continua restrita ao Crunchyroll; a fixture usa CDP diretamente apenas no teste,
sem modificar essa política ou fabricar uma identidade autenticada.

Foram executadas 317 requisições lógicas:

| Cenário | Quantidade | Resultado esperado e observado |
| --- | ---: | --- |
| JSON/Unicode com concorrência 1, 6, 24 e 64 | 256 | HTTP 200, identificação correta de cada resposta e sem truncamento |
| Recuperação após saturação CDP | 1 | HTTP 200 no mesmo navegador e geração de conexão |
| Falhas HTTP 429 e 503 | 24 | Status preservado, sem transformar a falha em sucesso |
| Redirects | 12 | Redirect manual opaco; destino não recebeu requisição |
| Conexões resetadas | 12 | `fetch` falhou, sem derrubar a conexão CDP |
| Respostas de 1 MiB | 12 | Truncamento e cancelamento antes de enviar a resposta completa, com limites de 4 KiB e 512 KiB |

O perfil tinha um cookie real da fixture. Nenhuma requisição da função de
produção o enviou, demonstrando `credentials: "omit"`. O teste também lançou
128 comandos CDP simultâneos, recusou o 129º por capacidade e verificou a
recuperação posterior. No encerramento, o navegador ficou `STOPPED` e nenhuma
requisição HTTP permaneceu ativa.

### Métricas da execução isolada

A fixture adiciona 20 ms de atraso por resposta JSON. Cada etapa envia 64
requisições; latências incluem espera no navegador, rede local e CDP.

| Concorrência solicitada | Pico HTTP no servidor | Duração da etapa | p50 | p95 | Requisições/s |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 1 | 1.526,46 ms | 23,18 ms | 27,69 ms | 41,93 |
| 6 | 6 | 273,89 ms | 24,76 ms | 26,27 ms | 233,67 |
| 24 | 6 | 246,95 ms | 85,81 ms | 91,88 ms | 259,16 |
| 64 | 6 | 243,15 ms | 130,79 ms | 237,75 ms | 263,21 |

Nesta origem HTTP/1.1, aumentar a concorrência de 6 para 64 elevou a espera,
enquanto o pico observado continuou em 6 requisições ativas. Isso identifica
fila por origem no navegador nesta fixture. Não demonstra o mesmo limite no
Crunchyroll real, que pode negociar protocolos ou políticas diferentes.

Foram observadas 323 tentativas HTTP para as 317 requisições lógicas: 6
tentativas extras ocorreram exclusivamente nos GETs com reset. Cada GET dessa
fixture teve de 1 a 3 tentativas. O próprio Chromium pode repetir requisições;
o MCP não implementou retries nesta execução. Não houve duplicação nos demais
cenários. A fonte oficial de rede do Chromium descreve retries em
[HttpNetworkTransaction](https://github.com/chromium/chromium/blob/main/net/http/http_network_transaction.cc).
Esse resultado não estabelece a ausência de retries nativos em mutações.

Dados da execução: [browser-load.json](validation-results/browser-load.json).

## Crunchyroll real

Também foi iniciado outro Chromium real, com perfil temporário, para navegação
HTTPS e 6 leituras anônimas com concorrência 2. Nenhum cookie ou header de
autorização foi enviado pelo probe; os corpos foram cancelados após os headers
e não foram registrados.

| Destino | Leituras | Resultado |
| --- | ---: | --- |
| Página inicial | 2 | HTTP 200 |
| `robots.txt` | 2 | HTTP 200 |
| API de categorias | 2 | HTTP 401, pois não havia autenticação |

O navegador recebeu respostas do provedor e foi encerrado. Isso valida
conectividade HTTPS pela rota do navegador e a exigência de autenticação,
sem validar conteúdo ou operações autenticadas da API.

O acesso por `curl` respondeu `CONNECT tunnel failed, response 403` no proxy,
enquanto o Chromium conseguiu HTTP 200. Portanto, o bloqueio observado nessa
rota não deve ser generalizado para toda a conectividade do ambiente.
Foram salvas no rascunho as permissões de `www.crunchyroll.com` e
`sso.crunchyroll.com`, preservando os presets existentes. O rascunho não aplica
nem publica alterações: para persistir essa configuração, revise e salve nas
configurações do ambiente e publique.

Dados da execução: [live-browser-probe.json](validation-results/live-browser-probe.json).

## Validação autenticada pendente

O runner `scripts/validate-live.ts` inicializou o MCP real via stdio e confirmou
as 21 ferramentas. `crunchyroll_status` retornou `LOGIN_REQUIRED`, sem sessão
autenticada. A tentativa com `--login` confirmou a ausência de `DISPLAY` e de
uma interface disponível para login interativo nesta máquina; nenhuma senha
ou token foi solicitado ou inventado.

O runner está preparado para 12 leituras autenticadas, com concorrência 2,
usando categorias, busca e browse, sem mutações nem retries. Ele verifica o
formato e a contagem das coleções retornadas, e reporta operação, resultado e
duração sem conteúdo da conta ou credenciais. **Essas 12 leituras não foram
executadas.** O exit code 2 sinaliza pré-requisito ausente, sem contabilizar
o cenário como aprovado.

Dados da tentativa: [live-mcp.json](validation-results/live-mcp.json).

## Reproduzir

No CachyOS/Arch, instale um navegador suportado com
`sudo pacman -S --needed chromium` e execute a validação com o usuário normal.
O npm 12 bloqueia scripts de dependências por padrão; o projeto aprova apenas
`esbuild@0.28.2` em `allowScripts`, para executar seu postinstall sem liberar
scripts de outras dependências. Instalação, tipos e build foram verificados
também com npm 12.2.0.

```bash
# Carga controlada: exige Chromium e seu sandbox funcional.
CRUNCHYROLL_BROWSER_EXECUTABLE=/usr/bin/chromium npm run test:browser

# Leituras anônimas no site real, sem login.
node --import tsx scripts/probe-live-browser.ts

# Em uma máquina com navegador visível e acesso ao provedor:
npm run build
npm run validate:live -- --login
```

Na nuvem, execute o teste do Chromium fora do isolamento adicional dos comandos
quando ele bloquear namespaces; mantenha o sandbox do navegador habilitado.
O login deve acontecer exclusivamente na janela do navegador gerenciado.
Depois da validação autenticada, feche essa janela; o runner fecha o processo
MCP, mas não chama logout nem apaga a sessão do usuário.

Os relatórios JSON podem ser salvos em caminhos escolhidos usando
`CRUNCHYROLL_LOAD_REPORT_PATH`, `CRUNCHYROLL_LIVE_PROBE_REPORT_PATH` e
`CRUNCHYROLL_LIVE_REPORT_PATH`, respectivamente. São caminhos de saída,
não credenciais. A suíte padrão usa fixtures locais; probes no provedor real
são executados somente por comandos explícitos.
