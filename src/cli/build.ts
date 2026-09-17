import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createJournal } from '../core/journal.js';
import { loadCache, withCache } from '../evaluator/cache.js';
import { withRetry } from '../evaluator/resilient.js';
import { loadCalibration } from '../evaluator/calibration.js';
import { createJevEvaluator, jevCredentialsPresent } from '../evaluator/jev.js';
import { createScriptedEvaluator } from '../evaluator/scripted.js';
import { autoApprovePort, cliPort, haltingPort, type HumanPort } from '../orchestration/human.js';
import { loadOverrideStore } from '../orchestration/overrides.js';
import { run } from '../orchestration/orchestrator.js';
import { formatRun } from '../report.js';
import { formatProbes, observeProbes, type ProbeResult } from '../agent/probe.js';
import { resolveRunner } from '../agent/runner.js';
import {
  loadSession,
  nextJournalPath,
  nextSession,
  saveSession,
  sessionPaths,
} from '../agent/session.js';
import {
  createWorkspaceEnv,
  createWorkspaceExecutor,
  formatExecutionLog,
  initialWorkspaceState,
  parseWorkspaceSpec,
  workspaceHeuristic,
  type WorkspaceSpec,
  type WorkspaceState,
} from '../agent/workspace.js';
import type { Args } from './args.js';

/**
 * Codigos de saida, para quem estiver dirigindo isto de fora num laco.
 *
 *   0  a tarefa terminou (todos os marcos e sondas do objetivo)
 *   3  progrediu e da para continuar: re-chame com a mesma --session
 *   4  parou e precisa de gente: humano recusou, abortou ou o leque secou
 *   2  erro de uso (spec invalida, credencial ausente)
 */
export const EXIT = { done: 0, usage: 2, continue: 3, needsHuman: 4 } as const;

function loadSpec(path: string): WorkspaceSpec {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  return parseWorkspaceSpec(raw);
}

export async function observeCommand(args: Args): Promise<number> {
  const specPath = args.str('spec', '');
  if (!specPath) {
    process.stderr.write('uso: jev observe --spec <spec.json>\n');
    return EXIT.usage;
  }
  const spec = loadSpec(specPath);
  const cwd = resolve(args.str('cwd', spec.cwd ?? process.cwd()));
  process.stdout.write(`sondas de "${spec.name}" em ${cwd}\n`);
  const results = await observeProbes(spec.probes, {
    cwd,
    onStart: (probe) => process.stdout.write(`  ... ${probe.id}\n`),
  });
  process.stdout.write(`${formatProbes(results)}\n`);
  const red = results.filter((r) => !r.ok);
  for (const probe of red) {
    if (probe.tail) process.stdout.write(`\n--- ${probe.id} ---\n${probe.tail}\n`);
    if (probe.error) process.stdout.write(`\n--- ${probe.id} ---\n${probe.error}\n`);
  }
  return red.length === 0 ? 0 : 1;
}

export async function buildCommand(args: Args): Promise<number> {
  const specPath = args.str('spec', '');
  if (!specPath) {
    process.stderr.write('uso: jev build --spec <spec.json> [--session <arquivo>] [--agent "<linha>"]\n');
    return EXIT.usage;
  }

  const spec = loadSpec(specPath);
  const cwd = resolve(args.str('cwd', spec.cwd ?? process.cwd()));
  const paths = sessionPaths(args.str('session', `runs/${spec.name}.session.json`));
  const previous = loadSession(paths.session);

  const runner = resolveRunner({
    template: args.options.get('agent'),
    preset: args.options.get('preset'),
  });

  // A guarda de credencial vem ANTES da medicao de abertura: descobrir que falta
  // chave depois de gastar meio minuto rodando sondas e desrespeito com quem
  // esta esperando na frente do terminal.
  const evaluatorName = args.str('evaluator', 'scripted');
  if (evaluatorName === 'jev' && !jevCredentialsPresent()) {
    process.stderr.write(
      'avaliador "jev" pedido sem AI_GATEWAY_API_KEY nem TYPESAFE_AI_API_KEY no ambiente.\n' +
        'Rode `pnpm ping` para conferir a credencial com uma chamada so.\n',
    );
    return EXIT.usage;
  }

  // Estado inicial: quando a sessao e nova, a primeira coisa que acontece e uma
  // MEDICAO. Comecar a planejar sem saber como o repositorio esta hoje seria
  // planejar em cima de suposicao desde o passo zero.
  let state: WorkspaceState;
  if (previous) {
    state = previous.state;
    process.stdout.write(
      `sessao   : ${paths.session} (corrida ${previous.runs + 1}, parou por "${previous.lastStop}")\n`,
    );
    if (args.has('reset-attempts')) {
      // Um passo esgotado por falha do AMBIENTE (agente sem login, rede fora)
      // ficaria morto para sempre, porque o contador de tentativas e o que o tira
      // do leque. Zerar e escolha explicita de quem esta dirigindo o laco.
      const spent = Object.keys(state.attempts).length;
      state = { ...state, attempts: {} };
      process.stdout.write(
        `           tentativas zeradas em ${spent} passo(s) por --reset-attempts\n`,
      );
    }
  } else {
    process.stdout.write(`sessao   : ${paths.session} (nova) — medindo o estado atual\n`);
    const opening: ProbeResult[] = await observeProbes(spec.probes, {
      cwd,
      onStart: (probe) => process.stdout.write(`  ... ${probe.id}\n`),
    });
    process.stdout.write(`${formatProbes(opening)}\n`);
    state = initialWorkspaceState(spec, opening);
  }

  const base =
    evaluatorName === 'jev'
      ? createJevEvaluator({
          seed: spec.name,
          // Conta hobby recusa ZDR com 500 antes de avaliar qualquer coisa.
          ...(args.has('no-zdr') ? { zeroDataRetention: false } : {}),
        })
      : createScriptedEvaluator({ id: `plano:${spec.name}`, heuristic: workspaceHeuristic(spec) });
  // Ordem importa: o cache fica POR FORA da repeticao, entao um acerto de cache
  // nao paga espera nenhuma, e so a chamada que vai de verdade a rede e que
  // ganha backoff.
  const resiliente = withRetry(base, {
    attempts: args.num('eval-attempts', 4),
    onRetry: ({ method, attempt, delayMs }) =>
      process.stdout.write(
        `  ! avaliador falhou em ${method} (tentativa ${attempt}); repetindo em ${Math.round(delayMs / 1000)}s\n`,
      ),
  });
  const evaluator = withCache(resiliente, loadCache(paths.cache));
  const calibration = loadCalibration(args.str('calibration', 'data/calibration.json'), base.id);

  const journal = createJournal(args.has('no-journal') ? null : nextJournalPath(paths.journal));
  const overrides = loadOverrideStore(paths.overrides);

  const { executor, log } = createWorkspaceExecutor({
    spec,
    runner,
    cwd,
    journal,
    onEvent: (message) => process.stdout.write(`  > ${message}\n`),
    ...(args.has('echo') ? { onOutput: (chunk: string) => process.stdout.write(chunk) } : {}),
  });

  let human: HumanPort;
  if (args.has('auto-approve')) human = autoApprovePort();
  else if (process.stdin.isTTY) human = cliPort();
  else human = haltingPort();

  if (runner.dry) {
    process.stdout.write(
      'modo dry-run: nenhum agente sera executado. As sondas rodam, o plano aparece,\n' +
        'e NENHUM marco e concedido. Use --agent "<linha>" ou --preset claude|codex para valer.\n',
    );
  }

  const result = await run(state, {
    env: createWorkspaceEnv(spec),
    evaluator,
    goal: spec.goal,
    journal,
    calibration,
    overrides,
    executor,
    human,
    maxSteps: args.num('steps', 4),
    maxRetriesPerStep: args.num('retries', 1),
    search: {
      iterations: args.num('iterations', 120),
      seed: `${spec.name}:${previous?.runs ?? 0}`,
      budget: { calls: args.num('calls', 2000), wallMs: args.num('search-ms', 60_000) },
    },
    gates: {
      // O valor aqui e sempre estimado: nao existe simulador de agente. Manter o
      // portao ligado faria TODO passo escalar. Desligar e escolha do operador, e
      // o relatorio continua dizendo que nenhuma folha foi medida.
      escalateOnSpeculativeValue: false,
      escalateAtOrAbove: args.str('escalate-at', 'costly') as 'costly',
    },
  });

  process.stdout.write(`${formatRun(result)}\n`);
  process.stdout.write(`${formatExecutionLog(log())}\n`);

  const finalProbes = Object.entries(result.finalState.probes)
    .map(([id, ok]) => `  ${ok === null ? '  ?  ' : ok ? 'VERDE' : 'VERM.'} ${id}`)
    .join('\n');
  process.stdout.write(`sondas    :\n${finalProbes}\n`);
  process.stdout.write(`marcos    : ${result.finalState.milestones.join(', ') || '(nenhum)'}\n`);

  saveSession(
    paths.session,
    nextSession(previous, {
      specPath,
      goal: spec.goal,
      state: result.finalState,
      lastStop: result.stopped,
    }),
  );
  overrides.save(paths.overrides);
  if (evaluator.stats.entries > 0) evaluator.save(paths.cache);

  const done = result.stopped === 'terminal';
  if (done) {
    process.stdout.write('\ntarefa concluida: todos os marcos e sondas do objetivo estao verdes.\n');
    return EXIT.done;
  }
  if (runner.dry) {
    // Passo sem prompt e medicao pura: ele CONCEDE mesmo em dry-run, porque a
    // medicao aconteceu de verdade. Quem nao concede e o passo que dependia de
    // um agente que nao foi chamado.
    const skipped = log().filter((r) => r.agent !== null && r.granted === null).length;
    process.stdout.write(
      `\ndry-run terminado. ${skipped} passo(s) precisavam de um agente e nao foram executados; ` +
        'o que aparece como concedido veio de medicao, nao de trabalho feito.\n',
    );
    return EXIT.continue;
  }
  if (result.stopped === 'evaluator-unavailable') {
    process.stdout.write(
      '\navaliador fora do ar. A sessao esta salva e o que ja ficou verde continua verde;\n' +
        `re-chame para continuar de onde parou:\n  jev build --spec ${specPath} --session ${paths.session}\n`,
    );
    return EXIT.needsHuman;
  }
  if (result.stopped === 'aborted' || result.stopped === 'blocked') {
    process.stdout.write(
      `\nparou e precisa de gente (${result.stopped}). A sessao esta salva; ` +
        `as recusas ficaram em ${paths.overrides} e valem nas proximas corridas.\n`,
    );
    return EXIT.needsHuman;
  }
  process.stdout.write(
    `\nprogrediu. Para continuar:\n  jev build --spec ${specPath} --session ${paths.session}\n`,
  );
  return EXIT.continue;
}
