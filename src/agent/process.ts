import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, isAbsolute, join, resolve } from 'node:path';

const WIN = process.platform === 'win32';

/**
 * Metacaracteres que o cmd.exe reinterpreta DEPOIS do quoting do Node.
 *
 * No Windows, `npx`/`pnpm`/`claude` costumam ser `.cmd`, e o Node exige passar
 * por um interpretador para executa-los. O quoting do Node protege espacos, mas
 * nao protege `&`, `|`, `^`, `>` — foi exatamente esse o buraco do CVE-2024-27980.
 * Em vez de tentar escapar, este modulo RECUSA o argumento e manda usar stdin.
 */
const CMD_META = /[&|<>^"%\r\n]/;

export interface CommandResult {
  /** Linha de comando como foi montada, para ir no journal e no relatorio. */
  readonly command: string;
  readonly code: number | null;
  readonly signal: string | null;
  /** `code === expectCode`. E isto, nao o texto da saida, que decide qualquer coisa. */
  readonly ok: boolean;
  readonly ms: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  /** true quando a saida foi cortada por `maxOutputChars`. */
  readonly truncated: boolean;
}

export interface RunCommandOptions {
  readonly cwd?: string;
  readonly timeoutMs?: number;
  readonly env?: NodeJS.ProcessEnv;
  /** Texto enviado ao stdin do processo. O caminho seguro para texto de modelo. */
  readonly input?: string;
  /** Corte da saida capturada, em caracteres. Guarda o FIM. Default 20000. */
  readonly maxOutputChars?: number;
  readonly expectCode?: number;
  /** Ecoa a saida enquanto ela sai (build longo). */
  readonly onOutput?: (chunk: string, stream: 'stdout' | 'stderr') => void;
}

const PATHEXT = (process.env['PATHEXT'] ?? '.COM;.EXE;.BAT;.CMD')
  .split(';')
  .filter(Boolean)
  .map((ext) => ext.toLowerCase());

/**
 * Onde o binario realmente esta.
 *
 * Existe porque `spawn('npx', ...)` sem shell falha no Windows: o que existe no
 * PATH e `npx.cmd`. Resolver aqui deixa o spawn sem shell no resto do modulo.
 */
export function resolveBin(name: string, cwd: string = process.cwd()): string | null {
  if (name.includes('/') || name.includes('\\')) {
    const direct = isAbsolute(name) ? name : resolve(cwd, name);
    return existsSync(direct) ? direct : null;
  }
  const dirs = (process.env['PATH'] ?? '').split(delimiter).filter(Boolean);
  for (const dir of dirs) {
    const base = join(dir, name);
    if (!WIN) {
      if (existsSync(base)) return base;
      continue;
    }
    if (existsSync(base) && /\.[a-z0-9]+$/i.test(name)) return base;
    for (const ext of PATHEXT) {
      if (existsSync(base + ext)) return base + ext;
    }
  }
  return null;
}

function needsInterpreter(bin: string): boolean {
  return WIN && /\.(cmd|bat)$/i.test(bin);
}

/**
 * Quoting para a linha unica que o cmd.exe recebe depois de `/c`.
 *
 * Sem isto, um binario em "C:\Program Files\..." vira dois tokens e o comando
 * morre com "'C:\Program' nao e reconhecido". Aspas internas nao precisam de
 * tratamento porque `CMD_META` ja recusou o argumento antes de chegar aqui;
 * resta a barra invertida final, que escaparia a aspa de fechamento.
 */
function quoteForCmd(arg: string): string {
  if (arg.length === 0) return '""';
  if (!/\s/.test(arg)) return arg;
  const trailing = /(\\+)$/.exec(arg)?.[1] ?? '';
  const body = trailing ? arg.slice(0, -trailing.length) + trailing.repeat(2) : arg;
  return `"${body}"`;
}

function clampTail(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  return { text: `…[${text.length - max} caracteres cortados]\n${text.slice(-max)}`, truncated: true };
}

export class CommandNotFoundError extends Error {
  constructor(public readonly bin: string) {
    super(
      `executavel nao encontrado no PATH: "${bin}". ` +
        'Instale-o ou passe o caminho completo (a busca cobre PATHEXT no Windows).',
    );
    this.name = 'CommandNotFoundError';
  }
}

/**
 * Roda um comando e devolve o que voltou. Nunca usa shell.
 *
 * O contrato: `ok` vem do codigo de saida, nunca do texto. O stdout e capturado
 * como EVIDENCIA para um humano ler — nada neste repositorio decide coisa alguma
 * lendo a saida de um processo.
 */
export async function runCommand(
  command: string,
  args: readonly string[] = [],
  options: RunCommandOptions = {},
): Promise<CommandResult> {
  const cwd = options.cwd ?? process.cwd();
  const bin = resolveBin(command, cwd);
  if (!bin) throw new CommandNotFoundError(command);

  let file = bin;
  let argv = [...args];
  let verbatim = false;
  if (needsInterpreter(bin)) {
    const offender = [bin, ...argv].find((arg) => CMD_META.test(arg));
    if (offender !== undefined) {
      throw new Error(
        `argumento com metacaractere de cmd.exe recusado para "${command}": ${JSON.stringify(
          offender.slice(0, 80),
        )}. ` + 'Passe o texto pelo stdin (promptMode "stdin") ou por arquivo em vez de argv.',
      );
    }
    // O idioma do Windows: a linha inteira entre um par extra de aspas, que o
    // `/s` remove antes de repassar o resto ja quotado ao interpretador.
    const line = [bin, ...args].map(quoteForCmd).join(' ');
    file = process.env['ComSpec'] ?? 'cmd.exe';
    argv = ['/d', '/s', '/c', `"${line}"`];
    verbatim = true;
  }

  const started = Date.now();
  const timeoutMs = options.timeoutMs ?? 300_000;
  const maxChars = options.maxOutputChars ?? 20_000;
  const printable = `${command}${args.length > 0 ? ' ' + args.join(' ') : ''}`;

  return await new Promise<CommandResult>((resolvePromise, rejectPromise) => {
    const child = spawn(file, argv, {
      cwd,
      env: options.env ?? process.env,
      windowsVerbatimArguments: verbatim,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
      // Se o processo ignorar o pedido educado, o proximo nao e negociavel.
      setTimeout(() => child.kill('SIGKILL'), 2000).unref();
    }, timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      options.onOutput?.(chunk, 'stdout');
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
      options.onOutput?.(chunk, 'stderr');
    });

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectPromise(error);
    });

    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const out = clampTail(stdout, maxChars);
      const err = clampTail(stderr, maxChars);
      resolvePromise({
        command: printable,
        code,
        signal,
        ok: !timedOut && code === (options.expectCode ?? 0),
        ms: Date.now() - started,
        stdout: out.text,
        stderr: err.text,
        timedOut,
        truncated: out.truncated || err.truncated,
      });
    });

    // Fechar o stdin e obrigatorio: sem isso um CLI que espera entrada trava ate
    // o timeout e a corrida inteira para por um prompt que ninguem vai responder.
    if (options.input !== undefined) child.stdin.end(options.input, 'utf8');
    else child.stdin.end();
  });
}
