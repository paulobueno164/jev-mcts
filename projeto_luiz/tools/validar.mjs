/**
 * O instrumento.
 *
 * Este arquivo e a unica coisa neste projeto que tem direito de dizer "passou".
 * Ele nao le nada que o agente escreveu sobre si mesmo: le os artefatos e mede.
 *
 *   node tools/validar.mjs --fase heads
 *   node tools/validar.mjs --fase registry
 *   node tools/validar.mjs --fase vetor
 *
 * Saida: 0 se passou, 1 se reprovou. Cada reprovacao imprime o porque, porque
 * essa saida volta para o agente na tentativa seguinte.
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const erros = [];
const notas = [];

const falhar = (msg) => erros.push(msg);
const nota = (msg) => notas.push(msg);

const DOMINIOS = new Set(['B3', 'CVM', 'DOU', 'CADE', 'JUDICIARIO', 'FISCAL', 'EMISSOR', 'MERCADO']);
const TIPOS = new Set(['boolean', 'choice', 'score']);
const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const TOTAL_MIN = 300;
const TOTAL_MAX = 340;

function lerJson(rel) {
  const caminho = resolve(RAIZ, rel);
  if (!existsSync(caminho)) {
    falhar(`arquivo ausente: ${rel}`);
    return null;
  }
  try {
    return JSON.parse(readFileSync(caminho, 'utf8'));
  } catch (e) {
    falhar(`${rel} nao e JSON valido: ${e.message}`);
    return null;
  }
}

/** Dimensoes que uma pergunta contribui, derivadas do TIPO — nunca do que ela declara. */
function dimensoesReais(q) {
  if (q.tipo === 'boolean') return 1;
  if (q.tipo === 'score') return 1;
  if (q.tipo === 'choice') return Array.isArray(q.opcoes) ? q.opcoes.length : 0;
  return 0;
}

function validarHeads() {
  const doc = lerJson('registry/heads.json');
  if (!doc) return null;

  if (doc.version !== 1) falhar(`heads.json: version deve ser 1, veio ${JSON.stringify(doc.version)}`);
  if (!Array.isArray(doc.heads)) {
    falhar('heads.json: campo "heads" tem de ser um array');
    return null;
  }
  const heads = doc.heads;
  if (heads.length < 10 || heads.length > 40) {
    falhar(`heads.json: sao ${heads.length} cabecas; o contrato pede entre 10 e 40`);
  }

  const vistos = new Set();
  let soma = 0;
  for (const [i, h] of heads.entries()) {
    const onde = `heads[${i}]${h && h.id ? ` (${h.id})` : ''}`;
    if (!h || typeof h !== 'object') {
      falhar(`${onde}: nao e um objeto`);
      continue;
    }
    if (typeof h.id !== 'string' || !KEBAB.test(h.id)) {
      falhar(`${onde}: id tem de ser kebab-case`);
    } else if (vistos.has(h.id)) {
      falhar(`${onde}: id repetido`);
    } else {
      vistos.add(h.id);
    }
    if (typeof h.nome !== 'string' || h.nome.length < 3) falhar(`${onde}: "nome" ausente ou curto demais`);
    if (!DOMINIOS.has(h.dominio)) {
      falhar(`${onde}: dominio ${JSON.stringify(h.dominio)} fora de {${[...DOMINIOS].join(', ')}}`);
    }
    if (typeof h.porqueOrtogonal !== 'string' || h.porqueOrtogonal.trim().length < 40) {
      falhar(`${onde}: "porqueOrtogonal" precisa de pelo menos 40 caracteres dizendo o que esta cabeca NAO mede`);
    }
    if (!Number.isInteger(h.orcamentoDimensoes) || h.orcamentoDimensoes < 4) {
      falhar(`${onde}: "orcamentoDimensoes" tem de ser inteiro >= 4`);
    } else {
      soma += h.orcamentoDimensoes;
    }
  }

  if (soma < TOTAL_MIN || soma > TOTAL_MAX) {
    falhar(`heads.json: soma dos orcamentos = ${soma}; o contrato pede [${TOTAL_MIN}, ${TOTAL_MAX}] (D ~ 320)`);
  }
  nota(`${heads.length} cabecas, orcamento somado = ${soma}`);
  return { heads, soma, ids: vistos };
}

function validarRegistry(infoHeads) {
  const doc = lerJson('registry/questions.json');
  if (!doc) return null;
  if (doc.version !== 1) falhar(`questions.json: version deve ser 1, veio ${JSON.stringify(doc.version)}`);
  if (!Array.isArray(doc.questions)) {
    falhar('questions.json: campo "questions" tem de ser um array');
    return null;
  }

  const qs = doc.questions;
  const idsVistos = new Set();
  const perguntasVistas = new Map();
  const porHead = new Map();
  const porTipo = { boolean: 0, score: 0, choice: 0 };
  let total = 0;

  for (const [i, q] of qs.entries()) {
    const onde = `questions[${i}]${q && q.id ? ` (${q.id})` : ''}`;
    if (!q || typeof q !== 'object') {
      falhar(`${onde}: nao e um objeto`);
      continue;
    }

    if (typeof q.id !== 'string' || q.id.length === 0) {
      falhar(`${onde}: id ausente`);
    } else if (idsVistos.has(q.id)) {
      falhar(`${onde}: id repetido`);
    } else {
      idsVistos.add(q.id);
    }

    if (infoHeads && typeof q.head === 'string') {
      if (!infoHeads.ids.has(q.head)) falhar(`${onde}: head "${q.head}" nao existe em heads.json`);
      if (typeof q.id === 'string' && !q.id.startsWith(`${q.head}.`)) {
        falhar(`${onde}: id tem de comecar com "${q.head}." (formato <head>.<slug>)`);
      } else if (typeof q.id === 'string') {
        // Um slug numerico passa por "unico" e nao diz nada a quem for usar a
        // feature depois. O nome da dimensao E a documentacao dela.
        const slug = q.id.slice(q.head.length + 1);
        if (!KEBAB.test(slug) || /^[0-9]+$/.test(slug) || slug.length < 3) {
          falhar(`${onde}: slug "${slug}" precisa ser kebab-case descritivo (>= 3 chars, nao so numero)`);
        }
      }
    } else {
      falhar(`${onde}: campo "head" ausente`);
    }

    if (!TIPOS.has(q.tipo)) {
      falhar(`${onde}: tipo ${JSON.stringify(q.tipo)} fora de {boolean, choice, score} — sao as unicas formas do avaliador`);
      continue;
    }

    if (typeof q.pergunta !== 'string' || q.pergunta.trim().length < 25) {
      falhar(`${onde}: "pergunta" precisa de pelo menos 25 caracteres`);
    } else if (!q.pergunta.trim().endsWith('?')) {
      falhar(`${onde}: "pergunta" tem de terminar em "?"`);
    } else {
      const chave = q.pergunta.trim().toLowerCase().replace(/\s+/g, ' ');
      if (perguntasVistas.has(chave)) {
        falhar(`${onde}: pergunta identica a de ${perguntasVistas.get(chave)} — cabecas ortogonais nao repetem pergunta`);
      } else {
        perguntasVistas.set(chave, q.id);
      }
    }

    if (typeof q.justificativa !== 'string' || q.justificativa.trim().length < 20) {
      falhar(`${onde}: "justificativa" precisa dizer em >= 20 caracteres o que esta feature compra`);
    }
    if (!DOMINIOS.has(q.fonte)) {
      falhar(`${onde}: fonte ${JSON.stringify(q.fonte)} fora de {${[...DOMINIOS].join(', ')}}`);
    }

    if (q.tipo === 'score') {
      if (!Array.isArray(q.niveis) || q.niveis.length < 3) {
        falhar(`${onde}: score exige "niveis" com pelo menos 3 niveis ordenados`);
      }
    }
    if (q.tipo === 'choice') {
      if (!Array.isArray(q.opcoes) || q.opcoes.length < 2) {
        falhar(`${onde}: choice exige "opcoes" com pelo menos 2 opcoes`);
      } else if (new Set(q.opcoes).size !== q.opcoes.length) {
        falhar(`${onde}: choice com opcoes repetidas`);
      }
    }

    porTipo[q.tipo]++;

    const real = dimensoesReais(q);
    if (q.dimensoes !== real) {
      falhar(`${onde}: declarou dimensoes=${JSON.stringify(q.dimensoes)}, mas o tipo "${q.tipo}" produz ${real}`);
    }
    total += real;
    if (typeof q.head === 'string') porHead.set(q.head, (porHead.get(q.head) ?? 0) + real);
  }

  if (total < TOTAL_MIN || total > TOTAL_MAX) {
    falhar(`questions.json: total de dimensoes = ${total}; o contrato pede [${TOTAL_MIN}, ${TOTAL_MAX}]`);
  }

  // Tudo boolean passa em todas as regras acima e entrega um tensor cego a
  // intensidade: "houve impacto?" sem "de que tamanho?". As tres formas existem
  // porque medem coisas diferentes; o registro tem de usar as tres.
  const nq = qs.length || 1;
  if (porTipo.boolean / nq > 0.7) {
    falhar(
      `mistura de formas: ${porTipo.boolean} de ${nq} perguntas sao boolean (${Math.round((porTipo.boolean / nq) * 100)}%); o teto e 70%`,
    );
  }
  if (porTipo.score / nq < 0.12) {
    falhar(
      `mistura de formas: so ${porTipo.score} de ${nq} perguntas sao score (${Math.round((porTipo.score / nq) * 100)}%); o piso e 12% — sem escala nao ha intensidade`,
    );
  }
  if (porTipo.choice / nq < 0.06) {
    falhar(
      `mistura de formas: so ${porTipo.choice} de ${nq} perguntas sao choice (${Math.round((porTipo.choice / nq) * 100)}%); o piso e 6% — sem distribuicao nao ha regime`,
    );
  }

  if (infoHeads) {
    for (const h of infoHeads.heads) {
      if (!h || typeof h.id !== 'string') continue;
      const real = porHead.get(h.id) ?? 0;
      if (real === 0) {
        falhar(`cabeca "${h.id}" nao tem nenhuma pergunta`);
        continue;
      }
      const alvo = h.orcamentoDimensoes;
      if (typeof alvo === 'number' && Math.abs(real - alvo) > Math.max(1, alvo * 0.2)) {
        falhar(`cabeca "${h.id}": orcamento ${alvo}, entregue ${real} — fora da folga de 20%`);
      }
    }
  }

  nota(
    `${qs.length} perguntas (${porTipo.boolean} boolean, ${porTipo.score} score, ${porTipo.choice} choice), ${total} dimensoes`,
  );
  return { questions: qs, total };
}

/** Respostas sinteticas DETERMINISTAS, geradas do proprio registro. */
function respostasSinteticas(questions) {
  const r = {};
  for (const [i, q] of questions.entries()) {
    if (q.tipo === 'boolean') r[q.id] = { probabilidade: ((i * 37) % 101) / 100 };
    else if (q.tipo === 'score') r[q.id] = { nivel: i % Math.max(1, (q.niveis?.length ?? 1)) };
    else if (q.tipo === 'choice') {
      const opcoes = q.opcoes ?? [];
      const dist = {};
      const peso = opcoes.map((_, j) => ((i + j) % 5) + 1);
      const soma = peso.reduce((a, b) => a + b, 0) || 1;
      opcoes.forEach((o, j) => { dist[o] = peso[j] / soma; });
      r[q.id] = { distribuicao: dist };
    }
  }
  return r;
}

async function validarVetor(infoRegistry) {
  const caminho = resolve(RAIZ, 'src/extrair.mjs');
  if (!existsSync(caminho)) {
    falhar('arquivo ausente: src/extrair.mjs');
    return;
  }
  let mod;
  try {
    mod = await import(pathToFileURL(caminho).href);
  } catch (e) {
    falhar(`src/extrair.mjs nao importa: ${e.message}`);
    return;
  }
  for (const fn of ['nomesDasDimensoes', 'extrairVetor']) {
    if (typeof mod[fn] !== 'function') falhar(`src/extrair.mjs nao exporta a funcao ${fn}`);
  }
  if (erros.length > 0) return;

  const D = infoRegistry ? infoRegistry.total : null;
  let nomes;
  try {
    nomes = mod.nomesDasDimensoes();
  } catch (e) {
    falhar(`nomesDasDimensoes() lancou: ${e.message}`);
    return;
  }
  if (!Array.isArray(nomes)) {
    falhar('nomesDasDimensoes() tem de devolver um array de strings');
    return;
  }
  if (D !== null && nomes.length !== D) {
    falhar(`nomesDasDimensoes() devolveu ${nomes.length} nomes, mas o registro soma ${D} dimensoes`);
  }
  if (new Set(nomes).size !== nomes.length) falhar('nomesDasDimensoes() tem nomes repetidos');

  const respostas = respostasSinteticas(infoRegistry ? infoRegistry.questions : []);
  let v1, v2, vVazio;
  try {
    v1 = mod.extrairVetor(respostas);
    v2 = mod.extrairVetor(respostas);
    vVazio = mod.extrairVetor({});
  } catch (e) {
    falhar(`extrairVetor lancou: ${e.message}`);
    return;
  }

  const checarVetor = (v, rotulo) => {
    if (!(v instanceof Float64Array)) {
      falhar(`${rotulo}: extrairVetor tem de devolver Float64Array, veio ${v && v.constructor ? v.constructor.name : typeof v}`);
      return false;
    }
    if (D !== null && v.length !== D) {
      falhar(`${rotulo}: vetor com ${v.length} posicoes, registro soma ${D}`);
      return false;
    }
    for (let i = 0; i < v.length; i++) {
      if (!Number.isFinite(v[i])) {
        falhar(`${rotulo}: posicao ${i} (${nomes[i] ?? '?'}) nao e finita (${v[i]})`);
        return false;
      }
      if (v[i] < 0 || v[i] > 1) {
        falhar(`${rotulo}: posicao ${i} (${nomes[i] ?? '?'}) = ${v[i]} fora de [0,1]`);
        return false;
      }
    }
    return true;
  };

  const ok1 = checarVetor(v1, 'respostas completas');
  checarVetor(vVazio, 'respostas AUSENTES (tem de cair no valor neutro, nunca NaN)');

  if (ok1) {
    let iguais = true;
    for (let i = 0; i < v1.length; i++) if (v1[i] !== v2[i]) { iguais = false; break; }
    if (!iguais) falhar('extrairVetor nao e determinista: duas chamadas com a mesma entrada divergiram');
    nota(`vetor de ${v1.length} posicoes, finito, em [0,1], determinista`);
  }
}

const argv = process.argv.slice(2);
const fase = argv[argv.indexOf('--fase') + 1] ?? 'tudo';

const infoHeads = validarHeads();
if (fase === 'registry' || fase === 'vetor' || fase === 'tudo') {
  const infoRegistry = validarRegistry(infoHeads);
  if (fase === 'vetor' || fase === 'tudo') await validarVetor(infoRegistry);
}

for (const n of notas) process.stdout.write(`  ok: ${n}\n`);
if (erros.length === 0) {
  process.stdout.write(`VALIDACAO OK (fase: ${fase})\n`);
  process.exit(0);
}
process.stdout.write(`\n${erros.length} REPROVACAO(OES) na fase "${fase}":\n`);
for (const e of erros.slice(0, 40)) process.stdout.write(`  - ${e}\n`);
if (erros.length > 40) process.stdout.write(`  ... e mais ${erros.length - 40}\n`);
process.exit(1);
