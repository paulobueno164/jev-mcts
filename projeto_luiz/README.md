# projeto_luiz — B3 Market Oracle pelo harness

Uma tarefa de verdade, dada ao `jev build` em vez de a uma pessoa: construir o
registro institucional de perguntas e o tensor de extração do **B3 Market Oracle**
descrito em [`PROMPT.md`](PROMPT.md).

Serve de banco de prova para a pergunta que interessa neste repositório: **um
harness bom o bastante faz um modelo fraco entregar?**

## As três peças

| arquivo | o que é |
|---|---|
| [`PROMPT.md`](PROMPT.md) | o enunciado recebido, em prosa, sem alteração |
| [`CONTRATO.md`](CONTRATO.md) | a forma exata da entrega — prosa não tem código de saída |
| [`tools/validar.mjs`](tools/validar.mjs) | **o instrumento**. A única coisa aqui com direito de dizer "passou" |
| [`spec.json`](spec.json) | os passos, as sondas e os ramos que a árvore pode escolher |

O agente **não pode editar** `validar.mjs`, `CONTRATO.md` nem `PROMPT.md`: uma
sonda confere o sha256 dos três a cada passo. Instrumento que muda para caber na
entrega não mediu nada.

## Rodar

```
tools\rodar.cmd
```

Roda o laço com o menor modelo do CLI (`claude-haiku-4-5`). Em outra janela,
`powershell -NoProfile -ExecutionPolicy Bypass -File tools\acompanhar.ps1` mostra
agente, sondas e artefatos ao vivo — ele mede por fora, não copia cor do log.

A permissão `Bash(node:*)` na linha do agente não é detalhe: com
`--permission-mode acceptEdits` sozinho o agente escreve os arquivos mas **não
consegue rodar o validador**, e fica pedindo aprovação a um terminal vazio.
Medido: 13,2 s até travar sem ela, 11,4 s até "Código de saída: 0" com ela.

## O leque

```
pnpm ramos projeto_luiz/spec.json
```

```
decisao 1: 1 legal   [ambiente]
decisao 2: 2 legais  [taxonomia-larga, taxonomia-densa]
decisao 3: 3 legais  [registro-gerador, registro-direto, registro-por-cabeca]
decisao 4: 2 legais  [tensor-derivado, tensor-materializado]
```

A primeira versão desta spec era encadeada e tinha **uma** ação legal por estado.
A MCTS rodava 120 iterações num galho só e imprimia `margem=1.000` — a margem era
1.000 porque não havia segundo colocado. Isso é uma fila, não uma busca, e foi
para separar os dois casos que existe o `pnpm ramos`.

## Onde parou

| corrida | modelo | resultado |
|---|---|---|
| 1 | sonnet-5 `--effort high` | 16 min no passo 2 sem produzir nada — sem permissão para executar o validador |
| 2 | haiku-4.5 | **3/3 marcos por medição em 6,4 min**: 25 cabeças, 300 perguntas, D = 300 |
| 3 | haiku-4.5, spec com ramos | parou no passo 1 — 429 do Vercel (`free tier rate-limited`) derrubou a corrida |

A corrida 2 fechou o objetivo, mas contra um contrato mais frouxo: as 300
perguntas saíram todas `boolean` e os ids eram `.1`, `.2`, `.3`. O contrato de
hoje exige slug descritivo e mistura de formas (no máximo 70% boolean, mínimo 12%
score e 6% choice) — a entrega da corrida 2 reprova com 303 erros no instrumento
atual.

A corrida 3 virou um defeito do harness, não do modelo: a exceção do avaliador
subia sem tratamento e matava a corrida inteira. Corrigido em
`src/evaluator/resilient.ts` — agora um 429 é repetido com backoff e, se
persistir, vira parada limpa com `stoppedBy: 'evaluator-unavailable'`, sessão
salva e código de saída 4.

## O que ainda não existe

O **Oracle rodando**. Nada aqui fala com a rede: `extrairVetor(respostas)` recebe
as respostas prontas e monta o vetor. Falta a peça que pega um fato relevante da
CVM e faz as ~300 perguntas ao avaliador para produzir essas respostas. O que
existe hoje é o registro e o montador — a percepção está especificada e não está
executada.
