import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { CommandNotFoundError, resolveBin, runCommand } from '../src/agent/process.js';
import { observeProbes, type Probe } from '../src/agent/probe.js';
import {
  dryRunner,
  splitCommandLine,
  templateRunner,
  type AgentRun,
  type AgentRunner,
} from '../src/agent/runner.js';
import { loadSession, nextSession, saveSession, sessionPaths } from '../src/agent/session.js';
import {
  createWorkspaceEnv,
  createWorkspaceExecutor,
  initialWorkspaceState,
  parseWorkspaceSpec,
  renderPrompt,
  tokensOf,
  workspaceHeuristic,
  type WorkspaceSpec,
} from '../src/agent/workspace.js';
import { createScriptedEvaluator } from '../src/evaluator/scripted.js';
import { haltingPort } from '../src/orchestration/human.js';
import { run } from '../src/orchestration/orchestrator.js';

const tmp = mkdtempSync(join(tmpdir(), 'jev-agent-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** `node` esta no PATH por definicao: um processo de verdade, sem mock. */
const green: Probe = { id: 'verde', label: 'sai 0', command: 'node', args: ['-e', 'process.exit(0)'] };
const red: Probe = { id: 'vermelha', label: 'sai 1', command: 'node', args: ['-e', 'console.error("estourou aqui");process.exit(1)'] };

function fakeRunner(over: Partial<AgentRun> = {}): AgentRunner & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    id: 'falso',
    dry: false,
    prompts,
    async run(prompt) {
      prompts.push(prompt);
      return {
        runner: 'falso',
        command: '(falso)',
        ok: true,
        code: 0,
        ms: 1,
        claim: 'pronto, tudo funcionando, pode confiar',
        stderr: '',
        timedOut: false,
        ...over,
      };
    },
  };
}

function spec(over: Partial<WorkspaceSpec> = {}): WorkspaceSpec {
  return parseWorkspaceSpec({
    name: 'teste',
    goal: 'deixar a sonda verde',
    probes: [green, red],
    goalMilestones: ['feito'],
    steps: [
      {
        key: 'agir',
        label: 'Fazer a coisa',
        risk: 'safe',
        yields: 'feito',
        verify: ['verde'],
        prompt: 'faca a coisa: {goal}',
      },
    ],
    ...over,
  });
}

describe('processo', () => {
  it('devolve codigo, saida e tempo de um comando real', async () => {
    const result = await runCommand('node', ['-e', 'process.stdout.write("oi")']);
    expect(result.ok).toBe(true);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('oi');
    expect(result.ms).toBeGreaterThanOrEqual(0);
  });

  it('codigo diferente de zero nao e sucesso, por mais que o texto diga que sim', async () => {
    const result = await runCommand('node', [
      '-e',
      'process.stdout.write("SUCESSO TOTAL");process.exit(3)',
    ]);
    expect(result.stdout).toContain('SUCESSO');
    expect(result.code).toBe(3);
    expect(result.ok).toBe(false);
  });

  it('o prompt vai pelo stdin sem passar por argv', async () => {
    const result = await runCommand(
      'node',
      ['-e', 'let b="";process.stdin.on("data",c=>b+=c).on("end",()=>process.stdout.write(b.toUpperCase()))'],
      { input: 'texto & com | metacaractere' },
    );
    expect(result.stdout).toBe('TEXTO & COM | METACARACTERE');
  });

  it('fecha o stdin sozinho: um comando que espera entrada nao trava a corrida', async () => {
    const result = await runCommand(
      'node',
      ['-e', 'let b="";process.stdin.on("data",c=>b+=c).on("end",()=>process.exit(b.length))'],
      { timeoutMs: 5000 },
    );
    expect(result.timedOut).toBe(false);
    expect(result.code).toBe(0);
  });

  it('o timeout mata o processo e marca o resultado', async () => {
    const result = await runCommand('node', ['-e', 'setTimeout(()=>{},60000)'], { timeoutMs: 300 });
    expect(result.timedOut).toBe(true);
    expect(result.ok).toBe(false);
  });

  it('binario ausente falha alto, com o nome do que faltou', async () => {
    await expect(runCommand('binario-que-nao-existe-jev', [])).rejects.toBeInstanceOf(
      CommandNotFoundError,
    );
    expect(resolveBin('binario-que-nao-existe-jev')).toBeNull();
    expect(resolveBin('node')).not.toBeNull();
  });
});

describe('sondas', () => {
  it('le o codigo de saida de cada sonda', async () => {
    const results = await observeProbes([green, red]);
    expect(results.map((r) => r.id)).toEqual(['verde', 'vermelha']);
    expect(results[0]?.ok).toBe(true);
    expect(results[1]?.ok).toBe(false);
    expect(results[1]?.tail).toContain('estourou aqui');
  });

  it('sonda que nem roda NAO conta como verde', async () => {
    // O modo de falha mais perigoso do modulo: um "command not found" silencioso
    // viraria "tudo certo" no estado, e o marco seria concedido por engano.
    const [result] = await observeProbes([
      { id: 'quebrada', label: 'inexistente', command: 'binario-que-nao-existe-jev' },
    ]);
    expect(result?.ok).toBe(false);
    expect(result?.error).toContain('nao encontrado');
  });
});

describe('runner', () => {
  it('divide a linha de comando respeitando aspas', () => {
    expect(splitCommandLine('claude -p')).toEqual(['claude', '-p']);
    expect(splitCommandLine('meu-agente --flag "com espaco" {prompt}')).toEqual([
      'meu-agente',
      '--flag',
      'com espaco',
      '{prompt}',
    ]);
    expect(splitCommandLine('bin --vazio ""')).toEqual(['bin', '--vazio', '']);
  });

  it('{prompt} no template liga o modo argv; sem ele, stdin', () => {
    expect(templateRunner('claude -p').id).toBe('claude -p');
    expect(() => templateRunner('')).toThrow(/vazio/);
  });

  it('o runner default nao executa nada', async () => {
    const runner = dryRunner();
    expect(runner.dry).toBe(true);
    const result = await runner.run('faca algo', { cwd: process.cwd(), timeoutMs: 1000 });
    expect(result.claim).toContain('dry-run');
  });
});

describe('spec', () => {
  it('aceita uma spec completa', () => {
    expect(spec().steps).toHaveLength(1);
  });

  it('recusa dependencia que nenhum passo produz', () => {
    expect(() =>
      spec({
        steps: [
          { key: 'a', label: 'A', risk: 'safe', yields: 'feito', requires: ['inexistente'] },
        ],
      }),
    ).toThrow(/inalcancavel/);
  });

  it('recusa verificacao por sonda inexistente', () => {
    expect(() =>
      spec({ steps: [{ key: 'a', label: 'A', risk: 'safe', yields: 'feito', verify: ['fantasma'] }] }),
    ).toThrow(/sonda inexistente/);
  });

  it('recusa risco fora do vocabulario', () => {
    expect(() =>
      spec({ steps: [{ key: 'a', label: 'A', risk: 'talvez', yields: 'feito' } as never] }),
    ).toThrow(/risco/);
  });

  it('recusa objetivo que nenhum passo alcanca', () => {
    expect(() => spec({ goalMilestones: ['lua'] })).toThrow(/nenhum passo produz/);
  });
});

describe('ambiente', () => {
  const twoSteps = () =>
    spec({
      goalMilestones: ['b'],
      steps: [
        { key: 'primeiro', label: 'Primeiro', risk: 'safe', yields: 'a', verify: ['verde'] },
        {
          key: 'segundo',
          label: 'Segundo',
          risk: 'safe',
          requires: ['a'],
          yields: 'b',
          verify: ['verde'],
        },
      ],
    });

  it('e speculative, e isso nao e configuravel', () => {
    expect(createWorkspaceEnv(spec()).fidelity).toBe('speculative');
  });

  it('dependencia nao satisfeita tira o passo do leque', () => {
    const s = twoSteps();
    const env = createWorkspaceEnv(s);
    const state = initialWorkspaceState(s);
    expect(env.actions(state).map((a) => a.key)).toEqual(['primeiro']);
    const after = { ...state, milestones: ['a'] };
    expect(env.actions(after).map((a) => a.key)).toEqual(['segundo']);
  });

  it('passo que esgotou as tentativas sai do leque em vez de repetir para sempre', () => {
    const s = twoSteps();
    const env = createWorkspaceEnv(s);
    const state = initialWorkspaceState(s);
    const exhausted = { ...state, attempts: { primeiro: state.maxAttemptsPerStep } };
    expect(env.actions(exhausted)).toHaveLength(0);
  });

  it('apply produz marco SUPOSTO, nunca observado', () => {
    const s = twoSteps();
    const env = createWorkspaceEnv(s);
    const next = env.apply(initialWorkspaceState(s), {
      key: 'primeiro',
      label: 'Primeiro',
      risk: 'safe',
    });
    expect(next.milestones).toEqual([]);
    expect(next.predicted).toContain('a');
    expect(tokensOf(next).has('a')).toBe(true);
  });

  it('termina quando todos os marcos e sondas do objetivo existem', () => {
    const s = twoSteps();
    const env = createWorkspaceEnv(s);
    const state = initialWorkspaceState(s);
    expect(env.terminal(state)).toBe(false);
    expect(env.terminal({ ...state, milestones: ['b'] })).toBe(true);
  });

  it('o teto de tempo de execucao encerra a sessao', () => {
    const s = twoSteps();
    const env = createWorkspaceEnv(s);
    const state = initialWorkspaceState(s);
    expect(env.terminal({ ...state, elapsedMs: state.budgetMs })).toBe(true);
  });

  it('a heuristica offline pontua progresso em direcao ao objetivo', () => {
    const s = twoSteps();
    const env = createWorkspaceEnv(s);
    const h = workspaceHeuristic(s);
    const state = initialWorkspaceState(s);
    expect(h.state(env.render(state))).toBe(0);
    expect(h.state(env.render({ ...state, milestones: ['b'] }))).toBe(1);
  });
});

describe('executor — onde a suposicao vira observacao', () => {
  it('o agente diz que deu certo, a sonda diz que nao: o marco NAO e concedido', async () => {
    // A regressao mais importante deste modulo. Se este teste cair, o harness
    // passa a conceder marco por texto de modelo, que e exatamente o que ele
    // existe para nao fazer.
    const s = spec({
      steps: [
        { key: 'agir', label: 'Fazer', risk: 'safe', yields: 'feito', verify: ['vermelha'], prompt: 'faca' },
      ],
    });
    const runner = fakeRunner();
    const { executor, log } = createWorkspaceExecutor({ spec: s, runner });
    const state = await executor(initialWorkspaceState(s), {
      key: 'agir',
      label: 'Fazer',
      risk: 'safe',
    });

    expect(runner.prompts).toHaveLength(1);
    expect(state.milestones).toEqual([]);
    expect(state.probes['vermelha']).toBe(false);
    expect(log()[0]?.granted).toBeNull();
    expect(log()[0]?.agent?.claim).toContain('pode confiar');
  });

  it('sonda verde concede o marco e mata toda predicao da arvore', async () => {
    const s = spec();
    const { executor } = createWorkspaceExecutor({ spec: s, runner: fakeRunner() });
    const before = { ...initialWorkspaceState(s), predicted: ['feito', 'probe:verde'] };
    const state = await executor(before, { key: 'agir', label: 'Fazer', risk: 'safe' });
    expect(state.milestones).toEqual(['feito']);
    expect(state.predicted).toEqual([]);
    expect(state.attempts['agir']).toBe(1);
    expect(state.elapsedMs).toBeGreaterThan(0);
  });

  it('dry-run nao concede marco nenhum', async () => {
    const s = spec();
    const { executor } = createWorkspaceExecutor({ spec: s, runner: dryRunner() });
    const state = await executor(initialWorkspaceState(s), {
      key: 'agir',
      label: 'Fazer',
      risk: 'safe',
    });
    expect(state.milestones).toEqual([]);
    expect(state.log.join('\n')).toContain('dry-run');
  });

  it('passo sem prompt e pura medicao, e a medicao concede', async () => {
    const s = spec({
      steps: [{ key: 'medir', label: 'Medir', risk: 'safe', yields: 'feito', verify: ['verde'] }],
    });
    const runner = fakeRunner();
    const { executor } = createWorkspaceExecutor({ spec: s, runner });
    const state = await executor(initialWorkspaceState(s), {
      key: 'medir',
      label: 'Medir',
      risk: 'safe',
    });
    expect(runner.prompts).toHaveLength(0);
    expect(state.milestones).toEqual(['feito']);
  });

  it('re-mede TODAS as sondas, nao so as do passo', async () => {
    const s = spec();
    const { executor } = createWorkspaceExecutor({ spec: s, runner: fakeRunner() });
    const state = await executor(initialWorkspaceState(s), {
      key: 'agir',
      label: 'Fazer',
      risk: 'safe',
    });
    expect(state.probes['verde']).toBe(true);
    expect(state.probes['vermelha']).toBe(false);
  });

  it('a saida da sonda reprovada volta para o prompt da tentativa seguinte', async () => {
    const s = spec({
      steps: [
        {
          key: 'agir',
          label: 'Fazer',
          risk: 'safe',
          yields: 'feito',
          verify: ['vermelha'],
          prompt: 'conserte isto:\n{failing}',
        },
      ],
    });
    const runner = fakeRunner();
    const { executor } = createWorkspaceExecutor({ spec: s, runner });
    const first = await executor(initialWorkspaceState(s), {
      key: 'agir',
      label: 'Fazer',
      risk: 'safe',
    });
    await executor(first, { key: 'agir', label: 'Fazer', risk: 'safe' });
    expect(runner.prompts[1]).toContain('estourou aqui');
  });

  it('renderPrompt preenche objetivo, marcos e tentativa', () => {
    const s = spec();
    const state = { ...initialWorkspaceState(s), milestones: ['x'] };
    const text = renderPrompt(
      { key: 'a', label: 'A', risk: 'safe', yields: 'feito', prompt: '{goal}|{milestones}|{attempt}' },
      state,
      3,
    );
    expect(text).toBe('deixar a sonda verde|x|3');
  });
});

describe('sessao', () => {
  it('sobrevive ao fim do processo', () => {
    const s = spec();
    const path = join(tmp, 'demo.session.json');
    expect(loadSession(path)).toBeNull();
    const state = { ...initialWorkspaceState(s), milestones: ['feito'] };
    saveSession(path, nextSession(null, { specPath: 'x.json', goal: s.goal, state, lastStop: 'max-steps' }));
    const loaded = loadSession(path);
    expect(loaded?.runs).toBe(1);
    expect(loaded?.state.milestones).toEqual(['feito']);

    const second = nextSession(loaded, {
      specPath: 'x.json',
      goal: s.goal,
      state: loaded!.state,
      lastStop: 'terminal',
    });
    expect(second.runs).toBe(2);
    expect(second.createdAt).toBe(loaded?.createdAt);
  });

  it('os caminhos irmaos ficam ao lado do arquivo de sessao', () => {
    const paths = sessionPaths('runs/x.session.json');
    expect(paths.overrides).toBe('runs/x.session.overrides.json');
    expect(paths.cache).toBe('runs/x.session.cache.json');
  });
});

describe('laco completo', () => {
  it('busca, executa, mede e chega ao fim com marcos observados', async () => {
    const s = spec({
      goalMilestones: ['b'],
      goalProbes: ['verde'],
      steps: [
        { key: 'primeiro', label: 'Primeiro', risk: 'safe', yields: 'a', verify: ['verde'], prompt: 'p1' },
        {
          key: 'segundo',
          label: 'Segundo',
          risk: 'safe',
          requires: ['a'],
          yields: 'b',
          verify: ['verde'],
          prompt: 'p2',
        },
      ],
    });
    const runner = fakeRunner();
    const { executor, log } = createWorkspaceExecutor({ spec: s, runner });

    const result = await run(initialWorkspaceState(s), {
      env: createWorkspaceEnv(s),
      evaluator: createScriptedEvaluator({ id: 'plano', heuristic: workspaceHeuristic(s) }),
      goal: s.goal,
      executor,
      // Porta que ABORTA: se algum portao escalar, o teste quebra em vez de
      // passar por baixo do pano.
      human: haltingPort(),
      maxSteps: 4,
      search: { iterations: 40, seed: 'laco' },
      gates: { minMargin: 0, escalateOnSpeculativeValue: false },
    });

    expect(result.stopped).toBe('terminal');
    expect([...result.finalState.milestones].sort()).toEqual(['a', 'b']);
    expect(result.steps.map((s2) => s2.applied?.key)).toEqual(['primeiro', 'segundo']);
    expect(runner.prompts).toEqual(['p1', 'p2']);
    expect(log().every((r) => r.granted !== null)).toBe(true);
    // Toda folha veio do avaliador: o ambiente e speculative e o relatorio diz.
    expect(result.provenance.measuredLeaves).toBe(0);
    expect(result.provenance.estimatedLeaves).toBeGreaterThan(0);
  });

  it('acao irreversivel escala mesmo aqui, e sem humano a corrida para', async () => {
    const s = spec({
      goalMilestones: ['feito'],
      steps: [
        {
          key: 'publicar',
          label: 'Publicar',
          risk: 'irreversible',
          yields: 'feito',
          verify: ['verde'],
          prompt: 'publique',
        },
      ],
    });
    const runner = fakeRunner();
    const { executor } = createWorkspaceExecutor({ spec: s, runner });
    const result = await run(initialWorkspaceState(s), {
      env: createWorkspaceEnv(s),
      evaluator: createScriptedEvaluator({ id: 'plano', heuristic: workspaceHeuristic(s) }),
      goal: s.goal,
      executor,
      human: haltingPort(),
      maxSteps: 2,
      search: { iterations: 20, seed: 'irrev' },
      gates: { minMargin: 0, escalateOnSpeculativeValue: false },
    });
    expect(result.stopped).toBe('aborted');
    expect(result.finalState.milestones).toEqual([]);
    // O ponto: o agente NAO foi chamado. Parar significa parar.
    expect(runner.prompts).toEqual([]);
  });
});
