import { createJevEvaluator, jevCredentialsPresent } from '../src/evaluator/jev.js';
import { parseArgs } from '../src/cli/args.js';

/**
 * Uma chamada de verdade ao Jev, e a leitura do que voltou.
 *
 * Existe porque os testes de contrato (`test/jev-contract.test.ts`) provam o
 * lado de ca — como o adaptador monta o slate, parte em blocos e mapeia a
 * resposta de volta para a chave — e nao provam nada sobre o lado de la. O
 * formato real da resposta so se conhece chamando. Este script chama uma vez
 * cada forma e imprime o cru, inclusive o erro, sem tratar.
 *
 *   pnpm ping
 *   pnpm ping --model typesafe-ai/jev --debias 2
 *   pnpm ping --no-zdr    # plano hobby: ZDR e recurso de Pro/Enterprise
 */
async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  if (!jevCredentialsPresent()) {
    process.stderr.write(
      'Sem credencial. Defina AI_GATEWAY_API_KEY (chave do Vercel AI Gateway) ou\n' +
        'TYPESAFE_AI_API_KEY no ambiente, ou copie .env.example para .env.\n' +
        'O Jev roda no AI Gateway com o id de modelo "typesafe-ai/jev" e exige\n' +
        'AI SDK >= 7.0.105 (este repositorio tem ' +
        (await import('ai/package.json', { with: { type: 'json' } })
          .then((m) => (m.default as { version: string }).version)
          .catch(() => '?')) +
        ').\n',
    );
    return 2;
  }

  const model = args.str('model', process.env['JEV_MODEL'] ?? 'typesafe-ai/jev');
  const passes = args.num('debias', 1) === 2 ? 2 : 1;
  // ZDR (zeroDataRetention) e o default do adaptador e e recurso pago no
  // Gateway: no plano hobby o servidor recusa a chamada inteira antes de
  // avaliar qualquer coisa. --no-zdr desliga explicitamente.
  const zdr = !args.has('no-zdr');
  const evaluator = createJevEvaluator({
    model,
    debiasPasses: passes,
    seed: 'ping',
    zeroDataRetention: zdr,
  });
  process.stdout.write(
    `modelo   : ${model}\navaliador: ${evaluator.id}\nZDR      : ${zdr ? 'ligado' : 'DESLIGADO (--no-zdr)'}\n\n`,
  );

  const state = {
    objetivo: 'Corrigir o calculo de desconto e cobrir com teste',
    fatos: ['a suite esta verde', 'o modulo afetado foi mapeado'],
    ja_feito: ['ler-spec', 'mapear-codigo'],
  };
  const candidates = [
    { key: 'implementar', label: 'Implementar a mudanca no modulo mapeado' },
    { key: 'publicar', label: 'Publicar em producao' },
    { key: 'escrever-teste', label: 'Escrever o teste que falha antes da correcao' },
  ];

  const timed = async <T>(name: string, fn: () => Promise<T>): Promise<T | null> => {
    const started = Date.now();
    try {
      const result = await fn();
      process.stdout.write(`--- ${name} (${Date.now() - started} ms) ---\n`);
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n\n`);
      return result;
    } catch (error) {
      // O erro cru e o dado mais valioso aqui: e ele que diz se o id do modelo,
      // o formato do estado ou a credencial e que estao errados.
      process.stdout.write(`--- ${name} FALHOU (${Date.now() - started} ms) ---\n`);
      process.stdout.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n\n`);
      return null;
    }
  };

  const screen = await timed('screen', () =>
    evaluator.screen({ state, question: 'Esta acao e um proximo passo razoavel agora?', candidates }),
  );
  const priors = await timed('priors', () =>
    evaluator.priors({ state, question: 'Qual e o melhor proximo passo?', candidates }),
  );
  const value = await timed('value', () =>
    evaluator.value({
      state,
      question: 'Quao perto este estado esta do objetivo?',
      levels: ['nao comecou', 'em andamento', 'quase la', 'concluido'],
    }),
  );

  const calls = (screen?.calls ?? 0) + (priors?.calls ?? 0) + (value?.calls ?? 0);
  const tokens =
    (screen?.usage.inputTokens ?? 0) + (priors?.usage.inputTokens ?? 0) + (value?.usage.inputTokens ?? 0);
  process.stdout.write(`total    : ${calls} chamadas, ${tokens} tokens de entrada\n`);

  const failed = [screen, priors, value].filter((r) => r === null).length;
  if (failed > 0) {
    process.stdout.write(`${failed} das 3 formas falharam — leia o stack acima.\n`);
    return 1;
  }
  // O que interessa conferir a olho: as chaves de `probability` e `distribution`
  // sao as CHAVES dos candidatos (nao os refs c0..cN), e `top` e uma delas.
  const keys = candidates.map((c) => c.key);
  const ok =
    keys.every((k) => k in (screen?.probability ?? {})) &&
    keys.every((k) => k in (priors?.distribution ?? {})) &&
    keys.includes(priors?.top ?? '');
  process.stdout.write(
    ok
      ? 'OK: as tres formas responderam e o mapeamento ref->chave bateu.\n'
      : 'ATENCAO: alguma resposta nao voltou nas chaves dos candidatos — o adaptador precisa de ajuste.\n',
  );
  return ok ? 0 : 1;
}

process.exit(await main());
