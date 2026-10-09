# Validação com navegador real e várias requisições

As medições iniciais na nuvem usam Chromium 151.0.7922.173 com sandbox nativo
habilitado e Node.js 24.19.0. A seção de validação autenticada no Linux registra
separadamente o relatório enviado pelo operador do seu PC. Os resultados são
observações dessas execuções, não uma estimativa de capacidade do Crunchyroll.

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

## Tentativa autenticada na nuvem — bloqueada

O runner `scripts/validate-live.ts` inicializou o MCP real via stdio e confirmou
as 21 ferramentas. `crunchyroll_status` retornou `LOGIN_REQUIRED`, sem sessão
autenticada. A tentativa com `--login` confirmou a ausência de `DISPLAY` e de
uma interface disponível para login interativo nesta máquina; nenhuma senha
ou token foi solicitado ou inventado.

O runner está preparado para 12 leituras autenticadas, com concorrência 2,
usando categorias, busca e browse, sem mutações nem retries. Ele verifica o
formato e a contagem das coleções retornadas, e reporta operação, resultado e
duração sem conteúdo da conta ou credenciais. **Essas 12 leituras não foram
executadas nessa tentativa na nuvem.** O exit code 2 sinaliza pré-requisito ausente, sem contabilizar
o cenário como aprovado.

Dados da tentativa: [live-mcp.json](validation-results/live-mcp.json).

## Validação autenticada no PC Linux — aprovada

Em 2026-10-08, o operador enviou a saída de execução em CachyOS/Linux do commit
`a59dd134d9b84474517fda564783e71f8a57c584`, usando `/usr/bin/chromium`.
O build passou. O teste local de persistência de sessão em dois subprocessos
passou em 840,23 ms, sem falha ou teste ignorado. As versões exatas do navegador
e Node não aparecem nesse relatório de execução.

A preparação manual encerrou normalmente, o MCP confirmou autenticação e
conexão com `authState: "PROFILE_READY"`, e todas as 12 chamadas de leitura
passaram com concorrência 2: `complete: true`, `status: "passed"`, zero falhas
e nenhum bloqueio. Foram quatro chamadas de categorias, quatro de busca por
Naruto e quatro de browse. O runner conferiu formato e contagem das coleções.

| Ferramenta | Chamadas aprovadas | Média | Mínimo | Máximo |
| --- | ---: | ---: | ---: | ---: |
| Categorias | 4/4 | 433,23 ms | 265,40 ms | 606,39 ms |
| Busca | 4/4 | 676,71 ms | 315,23 ms | 1.740,07 ms |
| Browse | 4/4 | 478,25 ms | 7,41 ms | 1.806,96 ms |

São latências de chamada MCP, incluindo transporte, autenticação corrente,
rede/navegador e normalização. O relatório não mede tempo até headers, TLS,
RSS, duração total do lote nem tentativas físicas de rede. A função de produção
não fixa `fetch.cache`; o cache HTTP do navegador pode participar dessas
leituras. As chamadas repetem os mesmos argumentos. A queda de latência nas
leituras posteriores é observada, mas cache, aquecimento e variação do provedor
não foram isolados. Quatro amostras por operação não estabelecem um gargalo
do provedor nem justificam introduzir cache no MCP.

Essa execução comprova o fluxo manual → perfil persistente → autenticação MCP
→ leituras naquele PC. As variáveis de sessão gráfica/desktop e o ambiente de
subprocesso foram alinhados antes da aprovação. A sequência de resultados não
isola qual mudança determinou a aprovação, nem prova a seleção específica de
chaveiro, ausência futura de desafios ou continuidade após reiniciar o PC.
Nenhuma mutação de conta foi testada.

Proveniência: o JSON foi transcrito da saída fornecida pelo usuário; esta
execução não foi feita nem acompanhada remotamente pelo agente. Não foram
recebidos cookies, tokens, dados de conta ou conteúdo das coleções. As tentativas
anteriores permanecem registradas e o resultado da nuvem não foi sobrescrito.

Dados da execução: [live-mcp-linux.json](validation-results/live-mcp-linux.json).

## Reproduzir

### Verificação de segurança presa no navegador gerenciado

Uma página de verificação da Cloudflare não demonstra, por si só, erro de senha
ou falta de conectividade. O repositório já registra uma tentativa de login
manual no mesmo perfil dedicado em
[BT4-N5](../CRUNCHYROLL-BT4-N5-ONBOARDING-ERRATA.md). Esse registro histórico não
prova que o procedimento funcionará em outra máquina ou navegador.

O runner `npm run validate:live -- --login` agora integra a preparação manual
antes de tentar autenticar pelo navegador gerenciado, quando a sessão MCP não
está autenticada. Aguarda o encerramento normal da janela manual e só executa
as 12 leituras após confirmação explícita de autenticação e conexão pelo MCP.
Um lock de perfil ou falha nessa preparação impede a tentativa gerenciada.

Também é possível testar apenas a etapa manual. Feche a janela gerenciada e
encerre o runner de validação antes de executar:

```bash
npm run onboard:browser
```

O comando usa o mesmo resolvedor de navegador do MCP e o mesmo perfil dedicado,
com as opções de abertura documentadas, sem porta de depuração, MCP ou CDP.
Recusa um perfil com `SingletonLock`, inclusive symlink pendente, e não apaga
controles de sessão. Não aceita argumentos de login, URL, perfil ou flags.
Faça a verificação e o login manualmente na página do provedor, decline qualquer
importação de dados de outro navegador e feche a janela normalmente. O script
não lê cookies, campos, conteúdo da página ou estado de autenticação.

Depois execute `npm run validate:live -- --login` para validar a autenticação
pelo MCP e as 12 leituras; ele abrirá novamente a etapa manual no mesmo perfil.
Informe separadamente se o login manual funcionou e se o MCP concluiu essas
leituras. Encerrar o navegador com sucesso não é um teste de autenticação
aprovado. O relatório distingue a fase de preparação, a validação gerenciada e
as leituras. Se a janela manual encerrar mas o MCP não autenticar, retorna
`auth_not_established_after_manual_browser` e zero leituras, sem repetir login.

Se a verificação também falhar nesta abertura direta, o problema não depende
exclusivamente da execução com MCP/CDP. Se funcionar e voltar a falhar no MCP,
a diferença na execução gerenciada é uma hipótese a investigar. O teste não
isola CDP das outras diferenças entre as execuções. O sucesso em Firefox ou
outro navegador não estabelece o resultado desse Chromium.

### Instalação e comandos de validação

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
O login acontece exclusivamente nas janelas do navegador, pela interface do
Crunchyroll; o runner usa primeiro a etapa manual no perfil dedicado.
O runner repassa explicitamente ao processo MCP as variáveis da sessão gráfica
(`DISPLAY`, `WAYLAND_DISPLAY`, `XDG_RUNTIME_DIR`, `XDG_SESSION_TYPE`, `XAUTHORITY`
e `DBUS_SESSION_BUS_ADDRESS`) e os overrides de navegador e sandbox. O SDK não
as herda por padrão: sem esse repasse, o terminal pode detectar uma sessão
gráfica enquanto o navegador iniciado pelo MCP não consegue abrir uma janela.
O repasse usa uma lista restrita e não registra os valores dessas variáveis.
As etapas manual e MCP também usam o mesmo ambiente de subprocesso, incluindo
`XDG_CURRENT_DESKTOP`, `DESKTOP_SESSION`, identificadores KDE/GNOME e diretórios
XDG. O Chromium usa identificadores da sessão para reconhecer o desktop Linux;
alterá-los entre as etapas é uma diferença que pode afetar o armazenamento
protegido. O runner não seleciona um armazenamento inseguro nem copia cookies.
Um teste com sessão sintética e Chromium real verifica a persistência no mesmo
perfil após reiniciar o navegador em outro subprocesso via SDK. Ambas as
execuções da fixture usam headless e CDP para encerramento normal na nuvem.
Esse teste local não comprova o login manual, a continuidade da conta
Crunchyroll nem o comportamento do chaveiro do seu PC.
Execute-o isoladamente com `npm run test:handoff`. O wrapper Linux também o
executa antes dos probes no provedor. A seleção de desktop do Chromium está em
[GetDesktopEnvironment](https://github.com/chromium/chromium/blob/main/base/nix/xdg_util.cc).
Depois da validação autenticada, feche essa janela; o runner fecha o processo
MCP, mas não chama logout nem apaga a sessão do usuário.

Os relatórios JSON podem ser salvos em caminhos escolhidos usando
`CRUNCHYROLL_LOAD_REPORT_PATH`, `CRUNCHYROLL_LIVE_PROBE_REPORT_PATH` e
`CRUNCHYROLL_LIVE_REPORT_PATH`, respectivamente. São caminhos de saída,
não credenciais. A suíte padrão usa fixtures locais; probes no provedor real
são executados somente por comandos explícitos.

Quando `CRUNCHYROLL_LIVE_REPORT_PATH` é definido, o runner também salva a fase
em andamento. `complete: false` e `status: "running"` indicam uma execução sem
resultado final; não representam aprovação. O JSON final usa `complete: true`.
