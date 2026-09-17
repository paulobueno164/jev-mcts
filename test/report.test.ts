import { describe, expect, it } from 'vitest';
import type { Decision, ValueSource } from '../src/core/types.js';
import type { GateVerdict } from '../src/orchestration/gates.js';
import type { HumanDecision } from '../src/orchestration/human.js';
import type { Attempt, RunResult, StepRecord } from '../src/orchestration/orchestrator.js';
import { formatRun } from '../src/report.js';
import type { SearchStats } from '../src/search/mcts.js';

type Sources = Readonly<Record<ValueSource, number>>;

function sources(over: Partial<Sources> = {}): Sources {
  return { 'grounded-reward': 0, 'grounded-rollout': 0, 'jev-score': 0, 'prior-only': 0, ...over };
}

function decision(over: Partial<Decision> = {}): Decision {
  return {
    action: { key: 'a', label: 'acao', risk: 'safe' },
    visits: 100,
    meanValue: 0.99,
    margin: 0.9,
    valueSource: 'grounded-rollout',
    valueSources: sources({ 'grounded-rollout': 100 }),
    groundedFraction: 1,
    confidence: 0.99,
    speculative: false,
    ranking: [{ key: 'a', label: 'acao', visits: 100, meanValue: 0.99, prior: 0.9 }],
    ...over,
  };
}

function stats(over: Partial<SearchStats> = {}): SearchStats {
  return {
    iterations: 200,
    nodes: 50,
    evaluatorCalls: 10,
    budget: { calls: 10, inputTokens: 0, outputTokens: 0, totalTokens: 0, wallMs: 5, usd: 0 },
    stoppedBy: 'iterations',
    depthCap: 24,
    depthCapClamped: false,
    calibrated: true,
    prunedByScreen: 0,
    ...over,
  };
}

const PROCEED: GateVerdict = { outcome: 'proceed', reasons: [] };

function attempt(
  d: Decision | null,
  over: { verdict?: GateVerdict; human?: HumanDecision; attempt?: number } = {},
): Attempt {
  return {
    attempt: over.attempt ?? 1,
    decision: d,
    verdict: over.verdict ?? PROCEED,
    stats: stats(),
    human: over.human ? { port: 'scripted', decision: over.human } : null,
  };
}

function step(n: number, attempts: readonly Attempt[], applied = true): StepRecord {
  const last = attempts[attempts.length - 1];
  return { step: n, attempts, applied: applied && last?.decision ? last.decision.action : null };
}

function result(over: {
  steps?: readonly StepRecord[];
  stopped?: RunResult<string>['stopped'];
  totals?: Partial<RunResult<string>['totals']>;
  provenance?: Partial<RunResult<string>['provenance']>;
} = {}): RunResult<string> {
  return {
    goal: 'testar o relatorio',
    finalState: 'fim',
    steps: over.steps ?? [],
    stopped: over.stopped ?? 'terminal',
    totals: {
      evaluatorCalls: 0,
      inputTokens: 0,
      usd: 0,
      wallMs: 0,
      escalations: 0,
      autonomous: 0,
      rejections: 0,
      ...over.totals,
    },
    provenance: {
      fidelity: 'grounded',
      depthCap: 24,
      depthCapClamped: false,
      calibrated: true,
      groundedDecisions: 0,
      speculativeDecisions: 0,
      measuredLeaves: 0,
      estimatedLeaves: 0,
      humanPort: 'halting',
      ...over.provenance,
    },
  };
}

/** A linha de procedencia da unica decisao do relatorio. */
function provenanceLineOf(d: Decision): string {
  const text = formatRun(result({ steps: [step(1, [attempt(d)])] }));
  const line = text.split('\n').find((l) => l.trim().startsWith('valor:'));
  if (!line) throw new Error(`relatorio sem linha de procedencia:\n${text}`);
  return line;
}

describe('relatorio: procedencia de cada decisao', () => {
  it('decisao com todas as folhas medidas mostra numerador igual ao denominador', () => {
    const line = provenanceLineOf(
      decision({
        valueSources: sources({ 'grounded-reward': 40, 'grounded-rollout': 60 }),
        groundedFraction: 1,
      }),
    );
    expect(line).toContain('100/100 folhas medidas');
    expect(line).toContain('playout real ate o fim');
    expect(line).not.toContain('estimad');
  });

  it('decisao com zero folhas medidas diz que nada foi executado', () => {
    const line = provenanceLineOf(
      decision({
        valueSource: 'jev-score',
        valueSources: sources({ 'jev-score': 200 }),
        groundedFraction: 0,
      }),
    );
    expect(line).toContain('0/200 folhas medidas');
    expect(line).toContain('nada foi executado');
    expect(line).toContain('tudo estimado pelo avaliador');
  });

  it('decisao mista carrega numerador E denominador, nunca so um rotulo', () => {
    // 3 folhas medidas nao compram o rotulo "medido" para 200.
    const line = provenanceLineOf(
      decision({
        valueSource: 'jev-score',
        valueSources: sources({ 'grounded-reward': 3, 'jev-score': 197 }),
        groundedFraction: 3 / 200,
      }),
    );
    expect(line).toContain('3/200 folhas medidas');
    expect(line).toMatch(/\(\d+%\)/);
    expect(line).toContain('197 estimadas pelo avaliador');
    expect(line).not.toContain('200/200');
    // O rotulo predominante sozinho ("nota do avaliador") nao substitui os numeros.
    expect(line).toMatch(/\d+\/\d+ folhas medidas/);
  });

  it('busca sem nenhuma folha avaliada diz isso em vez de inventar uma fracao', () => {
    const line = provenanceLineOf(
      decision({
        valueSource: 'prior-only',
        valueSources: sources(),
        groundedFraction: 0,
      }),
    );
    expect(line).toContain('nenhuma folha avaliada');
    expect(line).not.toMatch(/\d+\/\d+ folhas medidas/);
    expect(line).not.toContain('NaN');
  });

  it('folhas nao avaliadas (prior-only) entram no denominador, nao no numerador', () => {
    const line = provenanceLineOf(
      decision({
        valueSources: sources({ 'grounded-rollout': 50, 'prior-only': 50 }),
        groundedFraction: 0.5,
      }),
    );
    expect(line).toContain('50/100 folhas medidas');
    expect(line).not.toContain('100/100');
  });

  it('cada proposta de cada passo tem a sua linha de procedencia', () => {
    const medida = decision();
    const estimada = decision({
      action: { key: 'b', label: 'outra', risk: 'safe' },
      valueSource: 'jev-score',
      valueSources: sources({ 'jev-score': 100 }),
      groundedFraction: 0,
    });
    const text = formatRun(
      result({
        steps: [step(1, [attempt(medida)]), step(2, [attempt(estimada)])],
        totals: { autonomous: 2 },
      }),
    );
    const lines = text.split('\n').filter((l) => l.trim().startsWith('valor:'));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('100/100 folhas medidas');
    expect(lines[1]).toContain('0/100 folhas medidas');
  });
});

describe('relatorio: cabecalho e avisos', () => {
  it('sem curva de calibracao o cabecalho e o rodape avisam', () => {
    const text = formatRun(result({ provenance: { calibrated: false } }));
    expect(text).toContain('calibracao=AUSENTE (portoes no corte estrito)');
    expect(text).toContain('aviso     : sem curva de calibracao');
    expect(text).toContain('pnpm calibrate');
  });

  it('com curva ajustada o aviso de calibracao nao aparece', () => {
    const text = formatRun(result({ provenance: { calibrated: true } }));
    expect(text).toContain('calibracao=ajustada');
    expect(text).not.toContain('sem curva de calibracao');
  });

  it('ambiente speculative e anunciado no cabecalho e no rodape', () => {
    const text = formatRun(
      result({ provenance: { fidelity: 'speculative', depthCap: 2, depthCapClamped: true } }),
    );
    expect(text).toContain('fidelidade=speculative');
    expect(text).toContain('teto de profundidade=2 (recortado por ser speculative)');
    expect(text).toContain('aviso     : ambiente speculative');
    expect(text).toContain('suposicoes');
  });

  it('ambiente grounded nao recebe o aviso de speculative', () => {
    const text = formatRun(result({ provenance: { fidelity: 'grounded' } }));
    expect(text).toContain('fidelidade=grounded');
    expect(text).not.toContain('ambiente speculative');
    expect(text).not.toContain('recortado por ser speculative');
  });

  it('o cabecalho traz objetivo e porta humana', () => {
    const text = formatRun(result({ provenance: { humanPort: 'cli' } }));
    expect(text).toContain('objetivo : testar o relatorio');
    expect(text).toContain('porta humana=cli');
  });
});

describe('relatorio: rodape', () => {
  it('conta autonomas, escaladas e recusadas', () => {
    const text = formatRun(
      result({ totals: { autonomous: 3, escalations: 2, rejections: 1 } }),
    );
    expect(text).toContain('decisoes  : 3 autonomas, 2 escaladas ao humano, 1 recusadas');
  });

  it('a linha de folhas traz medidas, total, percentual e estimadas', () => {
    const text = formatRun(
      result({
        provenance: {
          groundedDecisions: 1,
          speculativeDecisions: 2,
          measuredLeaves: 150,
          estimatedLeaves: 50,
        },
      }),
    );
    expect(text).toContain('valores   : 1 decisoes 100% medidas, 2 com folha estimada');
    expect(text).toContain('folhas    : 150 medidas de 200 (75%), 50 estimadas pelo avaliador');
  });

  it('sem folha nenhuma o percentual e 0, nao NaN', () => {
    const text = formatRun(result({ provenance: { measuredLeaves: 0, estimatedLeaves: 0 } }));
    expect(text).toContain('folhas    : 0 medidas de 0 (0%), 0 estimadas pelo avaliador');
    expect(text).not.toContain('NaN');
  });

  it('a linha de custo traz chamadas, tokens, dolar e latencia', () => {
    const text = formatRun(
      result({ totals: { evaluatorCalls: 7, inputTokens: 1234, usd: 0.000052, wallMs: 798 } }),
    );
    expect(text).toContain(
      'custo     : 7 chamadas ao avaliador, 1234 tokens de entrada, US$ 0.000052, 798 ms',
    );
  });

  it('o motivo da parada e traduzido para o leitor', () => {
    expect(formatRun(result({ stopped: 'terminal' }))).toContain(
      'parou por : terminal (o ambiente considerou a tarefa concluida)',
    );
    expect(formatRun(result({ stopped: 'max-steps' }))).toContain('parou por : limite de passos');
    expect(formatRun(result({ stopped: 'aborted' }))).toContain('parou por : abortado pelo humano');
    expect(formatRun(result({ stopped: 'blocked' }))).toContain('parou por : bloqueado');
  });
});

describe('relatorio: linhas de passo', () => {
  it('decisao autonoma mostra acao, risco, visitas, valor, margem e confianca', () => {
    const text = formatRun(
      result({ steps: [step(1, [attempt(decision({ margin: 0.25, confidence: 0.8 }))])] }),
    );
    expect(text).toContain('passo 1 [autonomo] a  risco=safe  visitas=100  valor=0.990');
    expect(text).toContain('margem=0.250');
    expect(text).toContain('conf=0.800');
  });

  it('sem confianca aferida a linha diz n/a em vez de esconder', () => {
    const { confidence: _omitida, ...semConfianca } = decision();
    const text = formatRun(result({ steps: [step(1, [attempt(semConfianca)])] }));
    expect(text).toContain('conf=n/a');
  });

  it('proposta recusada pelo humano aparece com a via e a nota', () => {
    const escalate: GateVerdict = {
      outcome: 'escalate',
      reasons: [{ code: 'risk-threshold', detail: 'risco costly' }],
    };
    const recusada = attempt(decision({ action: { key: 'rm', label: 'apagar', risk: 'costly' } }), {
      verdict: escalate,
      human: { kind: 'reject', note: 'nao apaga isso' },
      attempt: 1,
    });
    const aprovada = attempt(decision({ action: { key: 'ls', label: 'listar', risk: 'safe' } }), {
      attempt: 2,
    });
    const text = formatRun(
      result({
        steps: [step(1, [recusada, aprovada])],
        totals: { autonomous: 1, escalations: 1, rejections: 1 },
      }),
    );
    expect(text).toContain('passo 1.1 [humano:reject] rm');
    expect(text).toContain('portao: risk-threshold');
    expect(text).toContain('humano: "nao apaga isso"');
    expect(text).toContain('passo 1.2 [autonomo] ls');
  });

  it('proposta aprovada pelo humano mostra a via humana, nao "autonomo"', () => {
    const escalate: GateVerdict = {
      outcome: 'escalate',
      reasons: [{ code: 'irreversible-action', detail: 'irreversivel' }],
    };
    const text = formatRun(
      result({
        steps: [
          step(1, [
            attempt(decision({ action: { key: 'push', label: 'push', risk: 'irreversible' } }), {
              verdict: escalate,
              human: { kind: 'approve' },
            }),
          ]),
        ],
        totals: { escalations: 1 },
      }),
    );
    expect(text).toContain('passo 1 [humano:approve] push  risco=irreversible');
    expect(text).toContain('portao: irreversible-action');
    expect(text).not.toContain('[autonomo]');
  });

  it('passo sem decisao registra os motivos do portao em vez de sumir', () => {
    const noDecision: GateVerdict = {
      outcome: 'escalate',
      reasons: [{ code: 'no-decision', detail: 'nada selecionavel' }],
    };
    const text = formatRun(
      result({
        steps: [step(1, [attempt(null, { verdict: noDecision })], false)],
        stopped: 'blocked',
        totals: { escalations: 1 },
      }),
    );
    expect(text).toContain('passo 1: sem decisao — no-decision');
  });

  it('decisao que nao chegou a ser aplicada nao aparece como autonoma', () => {
    const text = formatRun(
      result({
        steps: [step(1, [attempt(decision())], false)],
        stopped: 'aborted',
      }),
    );
    expect(text).toContain('passo 1 [nao aplicado] a');
    expect(text).not.toContain('[autonomo]');
  });
});
