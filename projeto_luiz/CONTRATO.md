# Contrato de entrega

Este arquivo existe porque `PROMPT.md` descreve um sistema em prosa, e prosa não
tem código de saída. O que segue é a forma exata que a entrega precisa ter para
que uma sonda consiga dizer **sim** ou **não** sobre ela.

Quem mede é `tools/validar.mjs`. Ele é o instrumento e **não pode ser editado
pelo agente** — se o instrumento muda para caber na entrega, não houve medição.

---

## Artefato 1 — `registry/heads.json`

A taxonomia das cabeças de percepção. Cada cabeça é um eixo **ortogonal**: duas
cabeças não podem responder à mesma pergunta com palavras diferentes.

```json
{
  "version": 1,
  "targetDimensions": 320,
  "heads": [
    {
      "id": "materialidade",
      "nome": "Materialidade do fato",
      "dominio": "CVM",
      "porqueOrtogonal": "Mede TAMANHO do impacto declarado; não mede direção, prazo nem credibilidade.",
      "orcamentoDimensoes": 24
    }
  ]
}
```

Regras verificadas:

- `version === 1`
- entre **10 e 40** cabeças
- `id` em `kebab-case`, único
- `dominio` ∈ `B3`, `CVM`, `DOU`, `CADE`, `JUDICIARIO`, `FISCAL`, `EMISSOR`, `MERCADO`
- `porqueOrtogonal` com no mínimo 40 caracteres — é onde se justifica que a cabeça
  não duplica outra
- `orcamentoDimensoes` ≥ 4
- a soma dos orçamentos cai em **[300, 340]** (o `D ≈ 320` do enunciado)

## Artefato 2 — `registry/questions.json`

O registro institucional de perguntas. Cada pergunta é uma chamada discriminativa
do Jev e produz um número (ou um vetor de números, no caso de `choice`).

```json
{
  "version": 1,
  "questions": [
    {
      "id": "materialidade.impacto-receita",
      "head": "materialidade",
      "tipo": "score",
      "pergunta": "Qual a ordem de grandeza do impacto declarado sobre a receita anual do emissor?",
      "niveis": ["imaterial", "< 1%", "1 a 5%", "5 a 20%", "> 20%"],
      "dimensoes": 1,
      "fonte": "CVM",
      "justificativa": "Separa fato relevante de comunicado de rotina sem ler número algum."
    }
  ]
}
```

Regras verificadas:

- `tipo` ∈ `boolean` | `choice` | `score` — **são as três formas que o avaliador
  do repositório expõe** (`src/evaluator/evaluator.ts`). Nenhuma outra existe.
- `score` exige `niveis` com ≥ 3 níveis ordenados; contribui `1` dimensão
- `choice` exige `opcoes` com ≥ 2 opções; contribui `opcoes.length` dimensões
- `boolean` contribui `1` dimensão
- `dimensoes` declarado tem de bater com a regra acima — declarar errado reprova
- `id` único, no formato `<head>.<slug>`, com `slug` em kebab-case descritivo de
  pelo menos 3 caracteres — `materialidade.1` reprova, `materialidade.impacto-receita`
  passa. O nome da dimensão é a documentação dela.
- `head` tem de existir em `heads.json`
- **mistura de formas**: no máximo 70% das perguntas podem ser `boolean`, pelo menos
  12% têm de ser `score` e pelo menos 6% `choice`. Um registro só de `boolean` responde
  "houve impacto?" e nunca "de que tamanho?" — as três formas existem porque medem
  coisas diferentes.
- `pergunta` com ≥ 25 caracteres, terminando em `?`
- nenhuma `pergunta` repetida (proxy de ortogonalidade)
- a soma das dimensões por cabeça tem de ficar a **±20%** do orçamento declarado
  daquela cabeça
- o total geral em **[300, 340]**

## Artefato 3 — `src/extrair.mjs`

O tensor propriamente dito: pega as respostas do Jev e devolve o vetor denso.

Precisa exportar exatamente isto:

```js
export function nomesDasDimensoes()   // => string[] de tamanho D, na ordem canonica, sem repeticao
export function extrairVetor(respostas) // => Float64Array de tamanho D
```

`respostas` é um objeto `{ [idDaPergunta]: resposta }`, onde a resposta segue o
que cada forma devolve:

- `boolean` → `{ probabilidade: number }` em `[0,1]`
- `score`   → `{ nivel: number }` inteiro em `[0, niveis.length - 1]`
- `choice`  → `{ distribuicao: { [opcao]: number } }` somando ~1

Regras verificadas:

- `nomesDasDimensoes()` devolve exatamente `D` nomes, únicos, e `D` é o total do
  artefato 2
- `extrairVetor` roda sobre respostas sinteticas que o proprio validador gera
  a partir de `questions.json` (uma por pergunta, deterministicas) e devolve `D`
  valores, **todos finitos e em `[0,1]`**
- pergunta **ausente** nas respostas não pode virar `NaN` nem explodir: vira o
  valor neutro documentado (0.5 para `boolean`, 0.5 para `score` normalizado,
  uniforme para `choice`)
- `score` é normalizado por `niveis.length - 1`, como faz `src/evaluator/jev.ts`
- rodar duas vezes com a mesma entrada dá o mesmo vetor (sem `Math.random`, sem
  `Date.now`)

---

## O que NÃO é entrega

- Não escreva cliente de rede, scraper de CVM/B3, nem nada que fale com a
  internet. O Oracle aqui é o **registro** e o **tensor**, não o coletor.
- Não invente uma quarta forma de pergunta. Se algo não cabe em
  `boolean`/`choice`/`score`, a resposta é que não cabe.
- Não edite `tools/validar.mjs`, `spec.json`, `CONTRATO.md` nem `PROMPT.md`.
