/**
 * Quantas acoes LEGAIS a busca tem para escolher em cada decisao de uma spec.
 *
 * Existe porque uma spec em que cada estado tem uma unica acao legal nao e uma
 * busca: e uma fila. A arvore roda, gasta iteracoes, imprime `visitas=120` e
 * `margem=1.000` — e nao escolheu nada, porque nao havia segundo lugar. Isso e
 * indistinguivel de exploracao de verdade no relatorio, e e por isso que tem
 * instrumento.
 *
 *   pnpm ramos examples/build/selfcheck.json
 */
import { readFileSync } from 'node:fs';
import {
  createWorkspaceEnv,
  initialWorkspaceState,
  parseWorkspaceSpec,
  type WorkspaceState,
} from '../src/agent/workspace.js';

const path = process.argv[2];
if (!path) {
  process.stderr.write('uso: pnpm ramos <spec.json>\n');
  process.exit(2);
}

const spec = parseWorkspaceSpec(JSON.parse(readFileSync(path, 'utf8')));
const env = createWorkspaceEnv(spec);

let state: WorkspaceState = initialWorkspaceState(spec);
let maiorLeque = 0;
let decisoes = 0;

process.stdout.write(`spec: ${spec.name}  (${spec.steps.length} passos)\n\n`);

for (let i = 1; i <= (spec.stepCap ?? 24); i++) {
  const legais = env.actions(state);
  if (legais.length === 0) {
    process.stdout.write(`decisao ${i}: nenhuma acao legal — fim\n`);
    break;
  }
  decisoes++;
  maiorLeque = Math.max(maiorLeque, legais.length);
  const marca = legais.length === 1 ? '  <- sem escolha' : '';
  process.stdout.write(
    `decisao ${i}: ${legais.length} legal(is)  [${legais.map((a) => a.key).join(', ')}]${marca}\n`,
  );

  // Segue o caminho otimista: a primeira acao legal funciona e concede o marco.
  // O que interessa aqui e o TAMANHO do leque, nao qual ramo vence.
  const escolhida = legais[0]!;
  const passo = spec.steps.find((s) => s.key === escolhida.key)!;
  const aplicado = env.apply(state, escolhida);
  state = {
    ...aplicado,
    milestones: [...state.milestones, passo.yields],
    predicted: [],
    probes: Object.fromEntries(
      Object.entries(state.probes).map(([id, ok]) =>
        (passo.verify ?? []).includes(id) ? [id, true] : [id, ok],
      ),
    ),
  };
}

process.stdout.write(
  `\nmaior leque: ${maiorLeque} acao(oes) em ${decisoes} decisao(oes)\n` +
    (maiorLeque <= 1
      ? 'VEREDITO: isto e uma fila, nao uma busca. A arvore nao teve o que escolher.\n'
      : 'VEREDITO: ha ramos de verdade — a arvore escolheu entre alternativas.\n'),
);
process.exit(maiorLeque <= 1 ? 1 : 0);
