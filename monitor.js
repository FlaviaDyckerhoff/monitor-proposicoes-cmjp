const fs = require('fs');
const nodemailer = require('nodemailer');

const EMAIL_DESTINO = process.env.EMAIL_DESTINO;
const EMAIL_REMETENTE = process.env.EMAIL_REMETENTE;
const EMAIL_SENHA = process.env.EMAIL_SENHA;
const ARQUIVO_ESTADO = 'estado.json';
const API_BASE = 'http://sapl.joaopessoa.pb.leg.br/api';

// A API da CMJP ignora ordering e sempre retorna IDs em ordem crescente.
// REQs são protocolados em volume alto e dominam os IDs mais altos,
// fazendo PLOs/PLCs novos ficarem enterrados nas páginas do meio.
//
// Estratégia em duas camadas:
// 1. Tipos legislativos principais: busca por tipo separada, últimas 2 páginas de cada
//    → garante PLO, PLC, IND, VETO, MP, PELO, PDL, PRE nunca sejam perdidos
// 2. Busca geral: últimas 2 páginas sem filtro de tipo
//    → captura REQ, OF, MSG e demais que dominam os IDs altos

const TIPOS_PRINCIPAIS = [
  { id: 1,  sigla: 'PLO'   },  // Projeto de Lei Ordinária
  { id: 5,  sigla: 'PLC'   },  // Projeto de Lei Complementar
  { id: 9,  sigla: 'PELO'  },  // Proposta de Emenda à Lei Orgânica
  { id: 6,  sigla: 'PDL'   },  // Projeto de Decreto Legislativo
  { id: 2,  sigla: 'PRE'   },  // Projeto de Resolução
  { id: 18, sigla: 'VETO'  },  // Veto
  { id: 16, sigla: 'MP'    },  // Medida Provisória
  { id: 8,  sigla: 'IND'   },  // Indicação
];

function carregarEstado() {
  if (fs.existsSync(ARQUIVO_ESTADO)) {
    return JSON.parse(fs.readFileSync(ARQUIVO_ESTADO, 'utf8'));
  }
  return { proposicoes_vistas: [], ultima_execucao: '' };
}

function salvarEstado(estado) {
  fs.writeFileSync(ARQUIVO_ESTADO, JSON.stringify(estado, null, 2));
}

function extrairTipo(str) {
  if (!str) return 'OUTROS';
  const match = str.match(/^(.+?)\s+n[oº°]/i);
  return match ? match[1].trim().toUpperCase() : str.split(' ').slice(0, 3).join(' ').toUpperCase();
}

function ordenarTipos(tipos) {
  // Tipos prioritários primeiro (ordem regimental), REQ e similares no fim
  const prioridade = [
    'VETO', 'MEDIDA PROVISÓRIA', 'PROPOSTA DE EMENDA À LEI ORGÂNICA',
    'PROJETO DE LEI COMPLEMENTAR', 'PROJETO DE LEI ORDINÁRIA',
    'PROJETO DE RESOLUÇÃO', 'PROJETO DE DECRETO LEGISLATIVO', 'INDICAÇÃO'
  ];
  const principais = tipos.filter(t => prioridade.includes(t)).sort((a, b) =>
    prioridade.indexOf(a) - prioridade.indexOf(b)
  );
  const reqs = tipos.filter(t => t.startsWith('REQ')).sort();
  const outros = tipos.filter(t => !principais.includes(t) && !reqs.includes(t)).sort();
  return [...principais, ...outros, ...reqs];
}

async function enviarEmail(novas) {
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: EMAIL_REMETENTE, pass: EMAIL_SENHA },
  });

  const porTipo = {};
  novas.forEach(p => {
    if (!porTipo[p.tipo]) porTipo[p.tipo] = [];
    porTipo[p.tipo].push(p);
  });

  const totalReqs = Object.keys(porTipo)
    .filter(t => t.startsWith('REQ'))
    .reduce((acc, t) => acc + porTipo[t].length, 0);
  const totalOutros = novas.length - totalReqs;

  const tiposOrdenados = ordenarTipos(Object.keys(porTipo));
  const primeiroReqIdx = tiposOrdenados.findIndex(t => t.startsWith('REQ'));

  const linhas = tiposOrdenados.map((tipo, idx) => {
    const isReq = tipo.startsWith('REQ');
    const bgHeader = isReq ? '#f5f0eb' : '#f0f4f8';
    const colorHeader = isReq ? '#5c3a1a' : '#1a3a5c';
    const borderColor = isReq ? '#5c3a1a' : '#1a3a5c';

    const separador = (isReq && idx === primeiroReqIdx && totalOutros > 0)
      ? `<tr><td colspan="4" style="padding:8px;background:#fff8f0;font-size:12px;color:#999;border-top:3px dashed #ddd;text-align:center">⬇️ Requerimentos (${totalReqs})</td></tr>`
      : '';

    const header = `<tr><td colspan="4" style="padding:10px 8px 4px;background:${bgHeader};font-weight:bold;color:${colorHeader};font-size:13px;border-top:2px solid ${borderColor}">${tipo} — ${porTipo[tipo].length} proposição(ões)</td></tr>`;
    const rows = porTipo[tipo].map(p =>
      `<tr>
        <td style="padding:8px;border-bottom:1px solid #eee"><strong>${p.numero}/${p.ano}</strong></td>
        <td style="padding:8px;border-bottom:1px solid #eee;font-size:12px;white-space:nowrap">${p.data}</td>
        <td style="padding:8px;border-bottom:1px solid #eee;font-size:12px">${p.autor}</td>
        <td style="padding:8px;border-bottom:1px solid #eee;font-size:12px">${p.ementa}</td>
      </tr>`
    ).join('');

    return separador + header + rows;
  }).join('');

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:900px;margin:0 auto">
      <h2 style="color:#1a3a5c;border-bottom:2px solid #1a3a5c;padding-bottom:8px">
        🏛️ CMJP — ${novas.length} nova(s) proposição(ões)
      </h2>
      <p style="color:#666">Monitoramento automático — ${new Date().toLocaleString('pt-BR')}</p>
      <table style="width:100%;border-collapse:collapse;font-size:14px">
        <thead>
          <tr style="background:#1a3a5c;color:white">
            <th style="padding:10px;text-align:left">Número/Ano</th>
            <th style="padding:10px;text-align:left">Data</th>
            <th style="padding:10px;text-align:left">Autor</th>
            <th style="padding:10px;text-align:left">Ementa</th>
          </tr>
        </thead>
        <tbody>${linhas}</tbody>
      </table>
      <p style="margin-top:20px;font-size:12px;color:#999">
        Acesse: <a href="https://sapl.joaopessoa.pb.leg.br/materia/pesquisar-materia">sapl.joaopessoa.pb.leg.br</a>
      </p>
    </div>
  `;

  await transporter.sendMail({
    from: `"Monitor CMJP" <${EMAIL_REMETENTE}>`,
    to: EMAIL_DESTINO,
    subject: `🏛️ CMJP: ${novas.length} nova(s) proposição(ões) — ${new Date().toLocaleDateString('pt-BR')}`,
    html,
  });

  console.log(`✅ Email enviado com ${novas.length} proposições novas (${totalReqs} REQs).`);
}

async function buscarPagina(ano, page, tipoId = null) {
  let url = `${API_BASE}/materia/materialegislativa/?ano=${ano}&page=${page}&page_size=100`;
  if (tipoId) url += `&tipo=${tipoId}`;
  const response = await fetch(url);
  if (!response.ok) {
    console.error(`❌ Erro na API (página ${page}${tipoId ? `, tipo ${tipoId}` : ''}): ${response.status}`);
    return null;
  }
  return await response.json();
}

async function buscarUltimasPaginas(ano, tipoId = null, sigla = 'geral') {
  // Sonda para descobrir total de páginas
  const sonda = await buscarPagina(ano, 1, tipoId);
  if (!sonda) return [];

  const total = sonda.pagination?.total_entries || 0;
  const totalPaginas = sonda.pagination?.total_pages || 1;

  if (total === 0) return [];
  console.log(`  📋 [${sigla}] ${total} proposições em ${totalPaginas} páginas`);

  // Buscar as 2 últimas páginas
  const paginasParaBuscar = [];
  if (totalPaginas >= 2) paginasParaBuscar.push(totalPaginas - 1);
  paginasParaBuscar.push(totalPaginas);

  const resultados = [];
  for (const pagina of paginasParaBuscar) {
    const dados = await buscarPagina(ano, pagina, tipoId);
    if (dados?.results) resultados.push(...dados.results);
  }

  return resultados;
}

async function buscarProposicoes() {
  const ano = new Date().getFullYear();
  console.log(`🔍 Buscando proposições de ${ano}...`);

  const todasRaw = [];
  const idsColetados = new Set();

  // Camada 1: tipos legislativos principais — busca por tipo
  console.log(`\n📌 Tipos legislativos principais:`);
  for (const tipo of TIPOS_PRINCIPAIS) {
    const resultados = await buscarUltimasPaginas(ano, tipo.id, tipo.sigla);
    for (const r of resultados) {
      if (!idsColetados.has(r.id)) {
        idsColetados.add(r.id);
        todasRaw.push(r);
      }
    }
  }

  // Camada 2: busca geral — captura REQ, OF, MSG e demais
  console.log(`\n📌 Busca geral (REQ, OF, MSG e outros):`);
  const gerais = await buscarUltimasPaginas(ano, null, 'geral');
  for (const r of gerais) {
    if (!idsColetados.has(r.id)) {
      idsColetados.add(r.id);
      todasRaw.push(r);
    }
  }

  console.log(`\n📦 Total carregado: ${todasRaw.length} proposições`);
  return todasRaw;
}

function normalizarProposicao(p) {
  const tipo = extrairTipo(p.__str__);

  let autor = '-';
  if (Array.isArray(p.autores) && p.autores.length > 0) {
    const primeiro = p.autores[0];
    if (typeof primeiro === 'object' && primeiro.nome) {
      autor = p.autores.map(a => a.nome).join(', ');
    }
  }

  return {
    id: p.id,
    tipo,
    numero: p.numero || '-',
    ano: p.ano || '-',
    autor,
    data: p.data_apresentacao || '-',
    ementa: (p.ementa || '-').substring(0, 200),
  };
}

(async () => {
  console.log('🚀 Iniciando monitor CMJP (João Pessoa)...');
  console.log(`⏰ ${new Date().toLocaleString('pt-BR')}`);

  const estado = carregarEstado();
  const idsVistos = new Set(estado.proposicoes_vistas);

  const proposicoesRaw = await buscarProposicoes();

  if (proposicoesRaw.length === 0) {
    console.log('⚠️ Nenhuma proposição encontrada.');
    process.exit(0);
  }

  const proposicoes = proposicoesRaw.map(normalizarProposicao);
  console.log(`📊 Total normalizado: ${proposicoes.length}`);

  const novas = proposicoes.filter(p => !idsVistos.has(p.id));
  console.log(`🆕 Proposições novas: ${novas.length}`);

  if (novas.length > 0) {
    // Ordena: principais primeiro (por tipo regimental), REQ no fim
    const prioridade = [
      'VETO', 'MEDIDA PROVISÓRIA', 'PROPOSTA DE EMENDA À LEI ORGÂNICA',
      'PROJETO DE LEI COMPLEMENTAR', 'PROJETO DE LEI ORDINÁRIA',
      'PROJETO DE RESOLUÇÃO', 'PROJETO DE DECRETO LEGISLATIVO', 'INDICAÇÃO'
    ];
    novas.sort((a, b) => {
      const aIdx = prioridade.indexOf(a.tipo);
      const bIdx = prioridade.indexOf(b.tipo);
      const aReq = a.tipo.startsWith('REQ');
      const bReq = b.tipo.startsWith('REQ');

      if (aReq !== bReq) return aReq ? 1 : -1;
      if (aIdx !== -1 && bIdx !== -1) return aIdx - bIdx;
      if (aIdx !== -1) return -1;
      if (bIdx !== -1) return 1;
      if (a.tipo < b.tipo) return -1;
      if (a.tipo > b.tipo) return 1;
      return (parseInt(b.numero) || 0) - (parseInt(a.numero) || 0);
    });

    await enviarEmail(novas);
    novas.forEach(p => idsVistos.add(p.id));
    estado.proposicoes_vistas = Array.from(idsVistos);
    estado.ultima_execucao = new Date().toISOString();
    salvarEstado(estado);
  } else {
    console.log('✅ Sem novidades. Nada a enviar.');
    estado.ultima_execucao = new Date().toISOString();
    salvarEstado(estado);
  }
})();
