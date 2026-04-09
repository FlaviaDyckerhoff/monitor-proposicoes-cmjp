const fs = require('fs');
const nodemailer = require('nodemailer');

const EMAIL_DESTINO = process.env.EMAIL_DESTINO;
const EMAIL_REMETENTE = process.env.EMAIL_REMETENTE;
const EMAIL_SENHA = process.env.EMAIL_SENHA;
const ARQUIVO_ESTADO = 'estado.json';
const API_BASE = 'https://sapl.joaopessoa.pb.leg.br/api';

// A API da CMJP ignora o parâmetro ordering e sempre retorna em ordem
// crescente de ID (menor para maior). As proposições mais recentes estão
// sempre nas ÚLTIMAS páginas, não na primeira.
// Estratégia: descobrir o total de páginas e buscar as 2 últimas
// (200 proposições), cobrindo qualquer volume entre execuções.

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
  const reqs = tipos.filter(t => t.startsWith('REQ')).sort();
  const outros = tipos.filter(t => !t.startsWith('REQ')).sort();
  return [...outros, ...reqs];
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

async function buscarPagina(ano, page) {
  const url = `${API_BASE}/materia/materialegislativa/?ano=${ano}&page=${page}&page_size=100`;
  const response = await fetch(url);
  if (!response.ok) {
    console.error(`❌ Erro na API (página ${page}): ${response.status}`);
    return null;
  }
  return await response.json();
}

async function buscarProposicoes() {
  const ano = new Date().getFullYear();
  console.log(`🔍 Buscando proposições de ${ano}...`);

  // Passo 1: sonda para descobrir total de páginas
  const sonda = await buscarPagina(ano, 1);
  if (!sonda) return [];

  const total = sonda.pagination?.total_entries || 0;
  const totalPaginas = sonda.pagination?.total_pages || 1;
  console.log(`📊 Total na API: ${total} proposições em ${totalPaginas} páginas`);

  // Passo 2: buscar as 2 últimas páginas (IDs mais altos = mais recentes)
  const paginasParaBuscar = [];
  if (totalPaginas >= 2) paginasParaBuscar.push(totalPaginas - 1);
  paginasParaBuscar.push(totalPaginas);

  const resultados = [];
  for (const pagina of paginasParaBuscar) {
    console.log(`📄 Buscando página ${pagina} de ${totalPaginas}...`);
    const dados = await buscarPagina(ano, pagina);
    if (dados?.results) {
      resultados.push(...dados.results);
    }
  }

  console.log(`📦 Proposições carregadas: ${resultados.length}`);
  return resultados;
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
    // REQ vai para o fim; dentro de cada grupo, número decrescente
    novas.sort((a, b) => {
      const aReq = a.tipo.startsWith('REQ');
      const bReq = b.tipo.startsWith('REQ');
      if (aReq !== bReq) return aReq ? 1 : -1;
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
