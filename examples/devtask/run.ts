import { join } from 'node:path';
import { parseArgs } from '../../src/cli/args.js';
import { createJournal } from '../../src/core/journal.js';
import { createScriptedEvaluator } from '../../src/evaluator/scripted.js';
import { createJevEvaluator, jevCredentialsPresent } from '../../src/evaluator/jev.js';
import { withCache } from '../../src/evaluator/cache.js';
import { loadCalibration } from '../../src/evaluator/calibration.js';
import type { Evaluator } from '../../src/evaluator/evaluator.js';
import { cliPort, type HumanPort } from '../../src/orchestration/human.js';
import { createOverrideStore } from '../../src/orchestration/overrides.js';
import { allAttempts, run } from '../../src/orchestration/orchestrator.js';
import { formatRun } from '../../src/report.js';
import {
  createDevTaskEnv,
  createDevTaskExecutor,
  devTaskHeuristic,
  initialState,
} from './env.js';

/**
 * O fluxo de orquestracao com o humano dentro.
 *
 * A busca propoe, os portoes medem, e tudo que for costly ou irreversivel para
 * na sua mesa com os numeros ao lado. Um "recusar" nao morre no passo: vira
 * proibicao para aquele estado e a busca refaz o plano sem a acao recusada.
 *
 * Sem `--interactive` o papel do humano e feito por uma politica fixa, para que
 * a demonstracao seja reproduzivel e caiba na suite.
 */

/** Humano de demonstracao: recusa producao e refatoracao fora de escopo, aprova o resto. */
function policyPort(): HumanPort {
  return {
    id: 'politica-de-demonstracao',
    async decide(request) {
      const key = request.decision.action.key;
      if (key === 'publicar') {
        return { kind: 'reject', note: 'producao so depois de revisao humana do PR' };
      }
      if (key === 'refatorar') {
        return { kind: 'reject', note: 'fora do escopo desta tarefa' };
      }
      if (key === 'apagar-branch') {
        return { kind: 'reject', note: 'o branch fica ate o PR ser mesclado' };
      }
      return { kind: 'approve', note: 'aprovado na revisao' };
    },
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const goal = args.str(
    'goal',
    'Corrigir o calculo de desconto e publicar a correcao em producao',
  );
  const kind = args.str('evaluator', 'scripted');
  const iterations = args.num('iterations', 120);
  const interactive = args.has('interactive');

  let inner: Evaluator;
  if (kind === 'jev') {
    if (!jevCredentialsPresent()) {
      process.stderr.write('sem AI_GATEWAY_API_KEY nem TYPESAFE_AI_API_KEY; use --evaluator scripted\n');
      process.exit(2);
    }
    inner = createJevEvaluator({ seed: 'devtask', debiasPasses: 2 });
  } else {
    inner = createScriptedEvaluator({ id: 'scripted:devtask', heuristic: devTaskHeuristic() });
  }
  const evaluator = withCache(inner);

  const journalPath = args.str('journal', join('runs', `devtask-${Date.now()}.ndjson`));
  const journal = createJournal(args.has('no-journal') ? null : journalPath);
  const overrides = createOverrideStore();
  const calibration = loadCalibration(args.str('calibration', 'data/calibration.json'), inner.id);

  const result = await run(initialState(goal), {
    env: createDevTaskEnv(),
    evaluator,
    goal,
    journal,
    calibration,
    overrides,
    executor: createDevTaskExecutor(),
    human: interactive ? cliPort() : policyPort(),
    maxSteps: args.num('max-steps', 10),
    search: {
      iterations,
      seed: args.str('seed', 'devtask'),
      budget: { calls: 2000, wallMs: 60_000 },
    },
    gates: {
      // O valor aqui e sempre estimado (o ambiente nao sabe medir nada). Se este
      // portao ficasse ligado, TODO passo escalaria e a demonstracao nao andaria.
      // Deixa-lo desligado e uma escolha do operador, e o relatorio a expoe:
      // a linha "valor:" de cada passo diz quantas folhas foram medidas, e a
      // linha "folhas" do rodape soma isso na corrida inteira.
      escalateOnSpeculativeValue: false,
      escalateAtOrAbove: 'costly',
    },
  });

  process.stdout.write(`${formatRun(result)}\n`);

  if (evaluator.stats.entries > 0 && journal.path) {
    const cachePath = journal.path.replace(/\.ndjson$/, '.cache.json');
    evaluator.save(cachePath);
    process.stdout.write(`journal : ${journal.path}\ncache   : ${cachePath}\n`);
    process.stdout.write(`replay  : pnpm cli replay ${journal.path}\n`);
  }
  process.stdout.write(
    `cache   : ${evaluator.stats.hits} acertos / ${evaluator.stats.misses} chamadas reais\n`,
  );

  const rejections = overrides.entries().filter((entry) => entry.banned.length > 0);
  if (rejections.length > 0) {
    process.stdout.write(`\nrecusas gravadas (viram proibicao em corridas futuras):\n`);
    for (const entry of rejections) {
      process.stdout.write(`  ${entry.stateKey.slice(0, 12)}  ${entry.banned.join(', ')}\n`);
      for (const note of entry.notes) process.stdout.write(`      "${note}"\n`);
    }
  }

  if (args.has('check')) {
    const problems: string[] = [];
    if (result.steps.some((step) => step.applied?.key === 'publicar')) {
      problems.push('acao irreversivel foi aplicada apesar da recusa humana');
    }
    const attempts = allAttempts(result);
    if (!attempts.some((a) => a.verdict.reasons.some((r) => r.code === 'irreversible-action'))) {
      problems.push('a corrida nunca chegou ao portao de acao irreversivel');
    }
    if (result.totals.rejections === 0) {
      problems.push('nenhuma proposta foi recusada: o laco humano nao foi exercitado');
    }
    if (problems.length > 0) {
      for (const problem of problems) process.stderr.write(`FALHOU: ${problem}\n`);
      process.exit(1);
    }
    process.stdout.write('\nOK: o portao irreversivel disparou e nada foi publicado sem aprovacao\n');
  }
}

await main();
