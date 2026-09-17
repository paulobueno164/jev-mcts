import { runCommand } from './process.js';

/**
 * O resultado de chamar um agente de CLI.
 *
 * `claim` e o stdout do agente. O nome e proposital: e uma AFIRMACAO dele, nao
 * uma prova. Nada neste repositorio concede marco, aprova portao ou muda estado
 * lendo esse campo — quem decide isso e sonda, com codigo de saida. O texto
 * existe para um humano ler e para realimentar a proxima tentativa.
 */
export interface AgentRun {
  readonly runner: string;
  readonly command: string;
  readonly ok: boolean;
  readonly code: number | null;
  readonly ms: number;
  readonly claim: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

export interface AgentContext {
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly onOutput?: (chunk: string, stream: 'stdout' | 'stderr') => void;
}

export interface AgentRunner {
  readonly id: string;
  /** true quando nada e executado de verdade (default seguro). */
  readonly dry: boolean;
  run(prompt: string, ctx: AgentContext): Promise<AgentRun>;
}

/**
 * Como o prompt chega ao agente.
 *
 *  - 'stdin' (default): o texto nunca entra em argv. E o unico modo seguro
 *    quando o binario e um `.cmd` do Windows, que passa por interpretador.
 *  - 'arg'  : substitui `{prompt}` em `args`. Use so com binario nativo.
 */
export type PromptMode = 'stdin' | 'arg';

export interface CommandRunnerOptions {
  readonly id?: string;
  readonly bin: string;
  readonly args?: readonly string[];
  readonly promptMode?: PromptMode;
  readonly env?: NodeJS.ProcessEnv;
}

export function commandRunner(options: CommandRunnerOptions): AgentRunner {
  const mode: PromptMode = options.promptMode ?? 'stdin';
  const baseArgs = options.args ?? [];
  const id = options.id ?? `${options.bin}${baseArgs.length ? ' ' + baseArgs.join(' ') : ''}`;

  return {
    id,
    dry: false,
    async run(prompt, ctx) {
      const args = mode === 'arg' ? baseArgs.map((a) => a.replaceAll('{prompt}', prompt)) : [...baseArgs];
      const result = await runCommand(options.bin, args, {
        cwd: ctx.cwd,
        timeoutMs: ctx.timeoutMs,
        ...(mode === 'stdin' ? { input: prompt } : {}),
        ...(options.env ? { env: options.env } : {}),
        ...(ctx.onOutput ? { onOutput: ctx.onOutput } : {}),
      });
      return {
        runner: id,
        command: result.command,
        ok: result.ok,
        code: result.code,
        ms: result.ms,
        claim: result.stdout,
        stderr: result.stderr,
        timedOut: result.timedOut,
      };
    },
  };
}

/**
 * Template de linha de comando: `"claude -p"`, `"codex exec"`, `"meu-agente --flag {prompt}"`.
 *
 * Divide respeitando aspas e NAO passa por shell. `{prompt}` em algum argumento
 * liga o modo 'arg'; sem ele, o prompt vai pelo stdin.
 */
export function templateRunner(template: string, promptMode?: PromptMode): AgentRunner {
  const parts = splitCommandLine(template);
  const bin = parts[0];
  if (!bin) throw new Error('template de agente vazio');
  const args = parts.slice(1);
  const mode: PromptMode =
    promptMode ?? (args.some((a) => a.includes('{prompt}')) ? 'arg' : 'stdin');
  return commandRunner({ id: template, bin, args, promptMode: mode });
}

export function splitCommandLine(line: string): string[] {
  const out: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let has = false;
  for (const ch of line) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (has || current.length > 0) out.push(current);
      current = '';
      has = false;
      continue;
    }
    current += ch;
  }
  if (has || current.length > 0) out.push(current);
  return out;
}

/**
 * Presets dos CLIs mais comuns.
 *
 * As flags sao as do modo nao-interativo documentado de cada ferramenta, mas
 * ELAS MUDAM entre versoes e este repositorio nao tem como conferir a que voce
 * instalou. Se o preset nao bater, use `--agent "<linha de comando>"`: o
 * template e o contrato, o preset e so atalho.
 */
export function claudeCodeRunner(extraArgs: readonly string[] = []): AgentRunner {
  return commandRunner({
    id: 'claude-code',
    bin: 'claude',
    args: ['-p', ...extraArgs],
    promptMode: 'stdin',
  });
}

export function codexRunner(extraArgs: readonly string[] = []): AgentRunner {
  return commandRunner({
    id: 'codex',
    bin: 'codex',
    args: ['exec', ...extraArgs],
    promptMode: 'stdin',
  });
}

/**
 * Nao executa nada. E o DEFAULT do `jev build`.
 *
 * Um harness que sai da caixa disparando um agente com poder de escrita no
 * repositorio de quem acabou de clonar seria um defeito, nao um recurso. Sem
 * `--agent`, a corrida so mede: roda as sondas e mostra o que a busca proporia.
 */
export function dryRunner(): AgentRunner {
  return {
    id: 'dry-run',
    dry: true,
    async run(prompt) {
      return {
        runner: 'dry-run',
        command: '(nenhum)',
        ok: true,
        code: 0,
        ms: 0,
        claim: `(dry-run: nenhum agente foi executado; o prompt teria ${prompt.length} caracteres)`,
        stderr: '',
        timedOut: false,
      };
    },
  };
}

export function resolveRunner(options: {
  readonly template?: string | undefined;
  readonly preset?: string | undefined;
}): AgentRunner {
  if (options.template) return templateRunner(options.template);
  switch (options.preset) {
    case undefined:
    case '':
    case 'dry':
      return dryRunner();
    case 'claude':
      return claudeCodeRunner();
    case 'codex':
      return codexRunner();
    default:
      throw new Error(
        `preset de agente desconhecido: "${options.preset}". Use claude, codex, dry ou --agent "<linha>".`,
      );
  }
}
