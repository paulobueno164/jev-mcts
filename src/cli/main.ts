#!/usr/bin/env node
import { readJournal, createJournal, type JournalEvent } from '../core/journal.js';
import { loadCache, replayOnly } from '../evaluator/cache.js';
import { identityCalibration } from '../evaluator/calibration.js';
import { scriptedPort, type HumanDecision } from '../orchestration/human.js';
import { createOverrideStore } from '../orchestration/overrides.js';
import { run } from '../orchestration/orchestrator.js';
import { formatRun } from '../report.js';
import { parseArgs } from './args.js';
import { buildCommand, observeCommand } from './build.js';
import {
  createDevTaskEnv,
  createDevTaskExecutor,
  initialState as devTaskInitial,
} from '../../examples/devtask/env.js';

const USAGE = `jev — busca em arvore com avaliacao tipada e portao humano

  jev build --spec <spec.json> [opcoes]
                                roda o laco: busca -> portao -> agente de CLI ->
                                sondas -> estado observado. Retomavel: re-chame
                                com a mesma --session e ele continua de onde parou.
      --session <arquivo>       onde a sessao vive (default runs/<nome>.session.json)
      --agent "<linha>"         linha de comando do agente, ex: --agent "claude -p"
      --preset claude|codex|dry preset no lugar de --agent (default dry: nao executa nada)
      --steps N                 passos nesta invocacao (default 4)
      --evaluator scripted|jev  quem da prior e valor (default scripted, offline)
      --no-zdr                  desliga zeroDataRetention (conta hobby do Gateway
                                recusa a chamada com ZDR ligado)
      --iterations N            iteracoes de busca por passo (default 120)
      --escalate-at <risco>     a partir de que risco o humano e chamado (default costly)
      --auto-approve            sem humano; recusa irreversivel mesmo assim
      --reset-attempts          zera o contador de tentativas ao retomar a sessao
                                (para passo que morreu por falha de ambiente)
      --echo                    ecoa a saida do agente enquanto ela sai
      --no-journal              nao grava o NDJSON

  jev observe --spec <spec.json>
                                so mede: roda as sondas e mostra o que voltou
  jev replay <journal.ndjson>   refaz uma corrida gravada, sem rede, e compara
                                acao a acao com o que foi decidido na hora
  jev help

Codigos de saida do build: 0 concluido, 3 progrediu (re-chame), 4 precisa de
gente, 2 erro de uso. Um laco externo e literalmente:

  while jev build --spec s.json --session runs/s.session.json; [ $? -eq 3 ]; do :; done

Bancadas:
  pnpm duel      compara guloso x mcts em ambiente com verdade conhecida
  pnpm devtask   fluxo de orquestracao com o humano no laco
  pnpm calibrate ajusta a curva de confiabilidade do avaliador
`;

function record(events: readonly JournalEvent[], type: string): Record<string, unknown>[] {
  return events
    .filter((event) => event.type === type)
    .map((event) => event.data as Record<string, unknown>);
}

/**
 * Replay.
 *
 * A unica prova de que uma corrida foi determinista e refaze-la a partir do
 * journal, servindo so avaliacoes gravadas, e comparar a sequencia de acoes.
 * Um pedido de avaliacao que nao esteja no cache derruba o replay de proposito:
 * significa que a corrida atual divergiu, e um replay que gasta rede para
 * "reproduzir" nao reproduziu nada.
 */
async function replay(path: string): Promise<number> {
  const events = readJournal(path);
  const start = record(events, 'run.start')[0];
  if (!start) {
    process.stderr.write(`journal sem evento run.start: ${path}\n`);
    return 2;
  }
  const envName = String(start['env']);
  if (envName !== 'devtask') {
    process.stderr.write(`replay so conhece o ambiente "devtask"; journal traz "${envName}"\n`);
    return 2;
  }

  const cachePath = path.replace(/\.ndjson$/, '.cache.json');
  const entries = loadCache(cachePath);
  if (Object.keys(entries).length === 0) {
    process.stderr.write(`cache de avaliacoes ausente ou vazio: ${cachePath}\n`);
    return 2;
  }

  const humanScript = record(events, 'human.decision').map(
    (data) => data['answer'] as HumanDecision,
  );
  const original = record(events, 'act').map((data) => String(data['action']));

  const journal = createJournal(null);
  const result = await run(devTaskInitial(String(start['goal'])), {
    env: createDevTaskEnv(),
    evaluator: replayOnly(entries, String(start['evaluator']).replace(/^cache\(|\)$/g, '')),
    goal: String(start['goal']),
    journal,
    calibration: identityCalibration(String(start['evaluator'])),
    overrides: createOverrideStore(),
    executor: createDevTaskExecutor(),
    human: scriptedPort(humanScript, 'replay'),
    maxSteps: Number(start['maxSteps'] ?? 10),
    maxRetriesPerStep: Number(start['maxRetriesPerStep'] ?? 2),
    search: { iterations: Number(start['iterations']), seed: String(start['seed']) },
    gates: (start['gates'] ?? {}) as Record<string, never>,
  });

  const replayed = record(journal.events(), 'act').map((data) => String(data['action']));
  process.stdout.write(`${formatRun(result)}\n`);

  const same =
    original.length === replayed.length && original.every((key, i) => key === replayed[i]);
  if (!same) {
    process.stderr.write(
      `DIVERGIU\n  gravado : ${original.join(' -> ')}\n  refeito : ${replayed.join(' -> ')}\n`,
    );
    return 1;
  }
  process.stdout.write(
    `\nreplay identico: ${replayed.length} acoes, 0 chamadas de rede\n  ${replayed.join(' -> ')}\n`,
  );
  return 0;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const command = args.positional[0] ?? 'help';

  if (command === 'build') {
    process.exit(await buildCommand(args));
  }

  if (command === 'observe') {
    process.exit(await observeCommand(args));
  }

  if (command === 'replay') {
    const path = args.positional[1];
    if (!path) {
      process.stderr.write('uso: jev replay <journal.ndjson>\n');
      process.exit(2);
    }
    process.exit(await replay(path));
  }

  process.stdout.write(USAGE);
  process.exit(command === 'help' ? 0 : 2);
}

await main();
