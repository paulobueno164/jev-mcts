import { runCommand, type CommandResult } from './process.js';

/**
 * Uma sonda e um comando cujo CODIGO DE SAIDA e um fato sobre o repositorio.
 *
 * E o unico instrumento de medicao deste modulo. Um agente de CLI pode escrever
 * "pronto, tudo passando" no stdout; a sonda e quem responde se `tsc` saiu com
 * zero. Marco nenhum e concedido por texto — so por sonda verde.
 */
export interface Probe {
  readonly id: string;
  readonly label: string;
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly timeoutMs?: number;
  /** Codigo de saida que conta como verde. Default 0. */
  readonly expectCode?: number;
}

export interface ProbeResult {
  readonly id: string;
  readonly label: string;
  readonly ok: boolean;
  readonly code: number | null;
  readonly ms: number;
  readonly timedOut: boolean;
  readonly command: string;
  /** Fim da saida, para um humano ler e para realimentar o agente. */
  readonly tail: string;
  /** Preenchido quando a sonda nem chegou a rodar (binario ausente, por ex.). */
  readonly error?: string;
}

export interface ObserveOptions {
  readonly cwd?: string;
  readonly maxTailChars?: number;
  readonly onStart?: (probe: Probe) => void;
  readonly onDone?: (result: ProbeResult) => void;
}

function tailOf(result: CommandResult, max: number): string {
  const merged = [result.stdout.trimEnd(), result.stderr.trimEnd()].filter(Boolean).join('\n');
  return merged.length > max ? merged.slice(-max) : merged;
}

/**
 * Roda as sondas EM SERIE.
 *
 * Em paralelo elas brigariam pelo mesmo diretorio de build; duas medicoes que
 * interferem uma na outra nao sao duas medicoes.
 */
export async function observeProbes(
  probes: readonly Probe[],
  options: ObserveOptions = {},
): Promise<ProbeResult[]> {
  const results: ProbeResult[] = [];
  const maxTail = options.maxTailChars ?? 4000;

  for (const probe of probes) {
    options.onStart?.(probe);
    const printable = `${probe.command}${probe.args?.length ? ' ' + probe.args.join(' ') : ''}`;
    let result: ProbeResult;
    try {
      const run = await runCommand(probe.command, probe.args ?? [], {
        cwd: probe.cwd ?? options.cwd ?? process.cwd(),
        timeoutMs: probe.timeoutMs ?? 300_000,
        ...(probe.expectCode !== undefined ? { expectCode: probe.expectCode } : {}),
      });
      result = {
        id: probe.id,
        label: probe.label,
        ok: run.ok,
        code: run.code,
        ms: run.ms,
        timedOut: run.timedOut,
        command: run.command,
        tail: tailOf(run, maxTail),
      };
    } catch (error) {
      // Sonda que nao roda NAO e sonda verde. E o caso mais perigoso do modulo:
      // um `command not found` silencioso viraria "tudo certo" no estado.
      result = {
        id: probe.id,
        label: probe.label,
        ok: false,
        code: null,
        ms: 0,
        timedOut: false,
        command: printable,
        tail: '',
        error: error instanceof Error ? error.message : String(error),
      };
    }
    results.push(result);
    options.onDone?.(result);
  }

  return results;
}

export function formatProbes(results: readonly ProbeResult[]): string {
  if (results.length === 0) return 'nenhuma sonda declarada — nada neste estado foi medido';
  const width = Math.max(...results.map((r) => r.id.length));
  return results
    .map((r) => {
      const mark = r.ok ? 'VERDE' : r.error ? 'ERRO ' : r.timedOut ? 'TEMPO' : 'VERM.';
      const detail = r.error ?? `codigo=${r.code ?? '-'}  ${r.ms} ms`;
      return `  [${mark}] ${r.id.padEnd(width)}  ${detail}  ${r.label}`;
    })
    .join('\n');
}
