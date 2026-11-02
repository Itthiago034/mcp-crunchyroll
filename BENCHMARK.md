# BENCHMARK — anterior × Crunchyroll MCP 2.0

Três tipos de número aparecem aqui e **nunca são misturados**:

- **REAL** — medido nesta sessão, em Chromium real (CfT 131, headless), contra a fixture loopback sintética. Não é a Crunchyroll.
- **SINTÉTICO** — medido executando código real (a lógica anterior copiada e a nova) contra fakes idênticos de authority/login/gateway. Latências de login/rede são simuladas.
- **MODELADO** — contagem de chamadas derivada das receitas da skill e do incidente relatado. Não medido; o Hermes não rodou aqui.

Dados brutos: `docs/validation-results/benchmark-player.json` (gerado em 2026-10-22T23:46Z).
Reproduzir: `CRUNCHYROLL_BROWSER_EXECUTABLE=<chrome> npx tsx scripts/benchmark-player.ts 15` (usuário sem privilégio).

## 1. Controle do player — REAL

15 iterações por ação, mesma aba, mesmo navegador. "Ad hoc" é uma **aproximação** do caminho
improvisado pelo Hermes: um processo Node novo por ação, que lê `DevToolsActivePort`, abre o próprio
WebSocket CDP, anexa à aba e faz `Runtime.evaluate` com `userGesture`. Ela **não** inclui o custo
dominante do incidente real — os turnos do LLM procurando arquivos, processos e escrevendo scripts.

| Ação | Nativo p50 / p95 (ms) | Nativo verificado | Ad hoc p50 / p95 (ms) | Ad hoc "ok" auto-relatado |
|---|---|---:|---|---:|
| play | 4.9 / 11.5 | 15/15 | 60.2 / 70.8 | 15/15 |
| pause | 4.3 / 7.1 | 15/15 | 60.4 / 78.3 | 15/15 |
| fullscreen | 7.4 / 13.9 | 15/15 | 65.6 / 82.3 | 15/15 |
| exit_fullscreen | 13.7 / 20.0 | 15/15 | 67.6 / 90.8 | 15/15 |
| status | 3.1 / 4.6 | 15/15 | — | — |

Observações:
- O nativo verifica por **sonda posterior** independente; o "ok" do ad hoc é o valor de retorno do
  próprio script (o que o Hermes teria). Ambos funcionaram aqui porque a fixture usada no
  comparativo tem o vídeo no documento top-level — o script ad hoc **não alcança** o player em
  iframe cross-site (o caso da suíte real), o nativo sim.
- `crunchyroll_play`-equivalente com `autoplay` (abrir + esperar player + play verificado): **219 ms** na fixture.
- CPU do processo Node por ação nativa: **2.38 ms** (média de 75 ações).
- RSS total do navegador (MiB): 1128 antes → 1156 após 75 ações → 1157 após 5 s ocioso → 1166 após
  mais 75 ações; 1163 após a rodada ad hoc. Há crescimento modesto (+28, depois +10) que **não**
  provamos ser zero; a ausência de sessões CDP anexadas foi verificada separadamente
  (`player-real-browser`, teste 7). Amostra pequena; não extrapolar.

## 2. Autenticação — SINTÉTICO

Mesmos fakes (login simulado 120 ms, request 20 ms; marcador de elegibilidade presente). Na coluna
"anterior", as chamadas de recuperação que a skill antiga mandava o agente fazer (login + repetir
cada falha) estão incluídas.

| Cenário | Impl. | Chamadas MCP | Resultados com erro | Tentativas de auth | Tentativas no gateway | Dispatches ao provedor |
|---|---|---:|---:|---:|---:|---:|
| Cold start, 1 consulta | anterior | 3 | 1 | 1 | 2 | 1 |
| | **nova** | **1** | **0** | 1 | **1** | 1 |
| Cold start, 2 consultas concorrentes | anterior | 5 | 2 | 1 | 4 | 2 |
| | **nova** | **2** | **0** | 1 | **2** | 2 |
| Sessão expirada, 1 consulta | anterior | 1 | 0 | 1 | 2 | 1 |
| | **nova** | 1 | 0 | 1 | **1** | 1 |
| Expirada, 10 concorrentes | anterior | 10 | 0 | 1 | 20 | 10 |
| | **nova** | 10 | 0 | 1 | **10** | 10 |

Latência de parede: ~141 ms em todos os casos, porque o fake não modela o turno do LLM; o ganho real
do cold start é **eliminar 2 chamadas MCP e 1 resultado de erro por consulta** (cada um custa um turno
do modelo). Não declaramos ganho de latência de ponta a ponta.

Retries automáticos de conteúdo: anterior 1 por chamada expirada (pós-falha); nova 0 nos cenários
acima (a pré-checagem evita) e no máximo 1, só pré-dispatch.

## 3. Fluxos do agente — MODELADO

| # | Cenário | Anterior (MCP / terminal) | Nova (MCP / terminal) |
|---|---|---|---|
| 1 | Abrir episódio após cold start ("coloca X ep 12") | 6 / 0 (search falha, login, search, seasons, episodes, play) | 4 / 0 |
| 2 | Retomar do histórico ("continua") | 4 / 0 (history falha, login, history, play) + play manual | 2 / 0 (history, play com `autoplay`) |
| 3 | Iniciar reprodução | 1 + improviso: ≥4 chamadas de terminal observadas no incidente (busca de arquivos/processos, descoberta do CDP, criar e rodar script) | 1 / 0 |
| 4 | Pausar | improviso por terminal | 1 / 0 |
| 5 | Tela cheia | improviso por terminal + mouse simulado | 1 / 0, com verificação |
| 6 | Sessão expirada | 1 / 0 (recuperação automática, 2 tentativas no gateway) | 1 / 0 (1 tentativa) |
| 7 | Duas consultas concorrentes no cold start | 5 / 0 | 2 / 0 |

Taxa de confirmação do estado do player: anterior **não havia** (o improviso não verificava de forma
independente); nova **100% nas 75 ações reais medidas** (todas `verified: true`).

## 4. O que não foi medido

- Latência ponta a ponta com o Hermes e com a Crunchyroll real.
- Player Vilos real, modo visível, DRM.
- Consumo de CPU/RAM do Hermes.
