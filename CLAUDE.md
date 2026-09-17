# jev-mcts — regras do repositório

Busca em árvore com avaliação tipada (TypeSafe Jev) e portão humano.
Leia o `README.md` para a tese; este arquivo é o que não pode ser quebrado.

## 1. A distinção grounded/speculative é o repositório

`Environment.fidelity` decide profundidade, procedência do valor e aperto dos
portões. Não é configuração e não se afrouxa em runtime.

- `grounded` — `apply()` devolve o estado **real**. Playout é medição.
- `speculative` — `apply()` devolve uma **suposição**. Profundidade tem teto duro
  (`speculativeMaxDepth`, default 2) e o recorte fica registrado em
  `stats.depthCapClamped`.

`rollout()` lança exceção em ambiente especulativo. Se você se pegar querendo
remover essa exceção, o que você quer é um simulador, não uma flag.

## 2. O avaliador não inventa estado

O avaliador tem exatamente três formas — `screen`, `priors`, `value` — e nenhuma
delas devolve texto livre nem produz um estado. O próximo estado vem **sempre**
de `env.apply`. Se uma proposta precisa que o modelo diga "e aí o estado vira X",
a resposta é não.

## 3. Se dá para medir, mede

Antes de acrescentar um `value()` do Jev em algum lugar, pergunte se o ambiente
sabe devolver `reward()`. Um número determinista do ambiente sempre ganha de uma
nota de classificador, e o relatório distingue os dois (`grounded-rollout` vs
`jev-score`).

Nenhum PR fecha com "parece melhor". Fecha com uma linha de `pnpm duel`,
`pnpm calibrate` ou um teste — um número, antes e depois.

## 4. A confiança crua nunca chega aos portões

A probabilidade que o Jev devolve não é acurácia. Tudo que os portões leem passa
por `calibrate()`. Sem curva ajustada, `stats.calibrated` é `false`, o corte
aplicado é o estrito e o relatório avisa. Uma curva é válida só para o `model` em
que foi ajustada; `loadCalibration` confere e recusa as outras.

## 5. Ação irreversível sempre pergunta

`applyGates` escala em `risk === 'irreversible'` antes de olhar qualquer limiar,
e nenhuma configuração desliga isso. Há um teste que afrouxa todos os limiares ao
mesmo tempo e verifica que o portão continua disparando — se você precisar mudar
esse teste, pare e converse.

A classe de risco é declarada pelo catálogo de ações. Um modelo não decide o que
é irreversível.

Sem porta humana configurada, escalar significa **parar**. Nunca significa
prosseguir porque não havia ninguém para perguntar.

## 6. O relatório não pode enganar

Toda linha de `formatRun` carrega a procedência do valor. Uma lista de
checkmarks que deixe o leitor supor que algo foi medido, quando foi estimado, é
pior do que não ter relatório. O rodapé sempre diz quantas decisões vieram de
cada lado.

## 6.1 Afirmação de agente não é medição

`src/agent/` fecha o laço com um CLI externo. A regra que faz esse módulo valer
alguma coisa: **marco só é concedido por sonda verde.** O stdout do agente chega
ao estado com o nome `claim` e não decide nada — nem marco, nem portão, nem
próximo passo. Se você se pegar lendo `claim` para tomar decisão, o que você quer
é uma sonda nova.

Sonda que não consegue rodar (binário ausente, timeout) **não é sonda verde**.
Um `command not found` silencioso virando "tudo certo" é o pior defeito possível
aqui, e há teste para ele.

O default do `jev build` é dry-run. Sair da caixa executando uma ferramenta com
poder de escrita no repositório de quem clonou seria defeito, não recurso.

Texto de modelo nunca vai para `argv` quando o binário passa por `cmd.exe`: vai
por stdin. Argumento com metacaractere de shell é recusado, não escapado.

## 7. Determinismo é testável ou não existe

- `Math.random` é proibido em `src/`. Toda aleatoriedade passa por `makeRng`.
- Toda avaliação é memoizada pelo hash do conteúdo (`digest`, chaves ordenadas).
- Todo evento vai para o journal NDJSON.
- `pnpm cli replay <journal>` refaz a corrida servindo **só** o que foi gravado;
  um miss derruba o replay em vez de gastar rede.

Qualquer mudança que quebre o replay de um journal existente é uma mudança de
comportamento, não um detalhe.

## 8. Orçamento é obrigatório

Toda busca corre sob um `Budget`. Estourar tem que ser uma parada limpa com
`stats.stoppedBy` preenchido e um portão `budget-exhausted` disparado — nunca uma
corrida que trava, nem uma que segue gastando.

Acerto de cache custa zero: não consome chamada, token nem dólar.

## 8.1 Avaliador que cai é parada, não crash

O avaliador é rede: 429, provedor fora do ar e timeout acontecem no meio de uma
corrida de quarenta minutos. `withRetry` repete o que é transitório com backoff
exponencial e converte o resto em `EvaluatorUnavailableError` — um tipo só, que o
orquestrador transforma em `stoppedBy: 'evaluator-unavailable'`, sessão salva e
código 4. Exceção não tratada aqui mata a corrida e **leva o progresso junto**,
que é o oposto do que a seção 8 exige.

Credencial inválida não é transitória. Repetir um 401 quatro vezes só atrasa o
diagnóstico em vinte segundos.

Sem jitter, de propósito: `Math.random` é proibido em `src/` e uma espera que
muda a cada corrida quebraria o replay.

## 8.2 Spec com uma ação legal por estado não é busca

`pnpm ramos <spec.json>` conta quantas ações **legais** a busca tem em cada
decisão. Uma spec encadeada, em que cada passo exige o marco do anterior, deixa
exatamente uma ação legal por estado: a MCTS gasta as 120 iterações num galho só
e ainda imprime `visitas=120 margem=1.000` — margem cheia porque não havia
segundo colocado. No relatório isso é indistinguível de exploração de verdade, e
por isso tem instrumento. `pnpm ramos` sai com 1 quando o maior leque é 1.

## 9. Custo real é latência, não dólar

$0,042 por milhão de tokens de entrada torna o dinheiro irrelevante em qualquer
escala que este repositório alcance. 114 ms por chamada, não. Ao avaliar uma
mudança que acrescenta chamadas, reporte `lat@114ms`, não só `US$`.

## 10. Comandos

```bash
pnpm check      # typecheck + suite + a asserção do duelo
pnpm duel       # bancada com verdade conhecida
pnpm devtask    # fluxo de orquestração com humano no laço
pnpm calibrate  # curva de confiabilidade contra verdade exata
pnpm ramos <spec.json>   # quantas acoes legais a busca tem em cada decisao
pnpm cli replay runs/<arquivo>.ndjson

pnpm observe --spec examples/build/selfcheck.json   # só mede o repositório
pnpm agent   --spec examples/build/selfcheck.json   # laço com agente de CLI
```

`jev build` é retomável: re-chamar com a mesma `--session` continua de onde
parou. Códigos de saída: 0 concluído, 3 progrediu (re-chame), 4 precisa de gente,
2 erro de uso. Uma sessão de build **não** é replicável — o repositório mudou
entre as corridas, e o NDJSON dela é auditoria, não replay.

Tudo roda offline por padrão. `--evaluator jev` exige `AI_GATEWAY_API_KEY` ou
`TYPESAFE_AI_API_KEY`; nenhum teste fala com a rede.

A chave mora no `.env`, que está no `.gitignore` — **nunca** no `.env.example`,
que é modelo e vai junto no repositório. Só os scripts do `package.json` carregam
o `.env` (`tsx --env-file-if-exists=.env`); um `tsx` chamado na mão não carrega.
O SDK lê só `AI_GATEWAY_API_KEY`: `TYPESAFE_AI_API_KEY` é alias e
`createJevEvaluator` faz a ponte antes da primeira chamada.

`zeroDataRetention` é o default e é recurso de plano Pro/Enterprise. Em conta
hobby o Gateway recusa com 500 antes de avaliar qualquer coisa; `--no-zdr`
desliga, e desligar é decisão de quem roda, não default silencioso.
