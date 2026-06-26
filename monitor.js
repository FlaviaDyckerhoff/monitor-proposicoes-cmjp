const fs = require('fs');

const EMAIL_DESTINO = process.env.EMAIL_DESTINO;
const EMAIL_REMETENTE = process.env.EMAIL_REMETENTE;
const EMAIL_SENHA = process.env.EMAIL_SENHA;
const ARQUIVO_ESTADO = 'estado.json';
const API_BASE = 'https://sapl.joaopessoa.pb.leg.br/api';
const CASA_NOME = 'Câmara Municipal de João Pessoa';
const EMAIL_LOCALIDADE = 'João Pessoa';
const MATERIA_BASE = 'https://sapl.joaopessoa.pb.leg.br/materia';

const ABRASEL_PB_TERMOS = [
  'Abrasel', 'Abrasel PB', 'Abrasel Paraíba',
  'bar', 'bares', 'restaurante', 'restaurantes', 'lanchonete', 'lanchonetes',
  'alimentação fora do lar', 'refeição', 'refeições', 'alimento', 'alimentos',
  'delivery', 'entrega de alimentos', 'aplicativo de entrega', 'ifood',
  'bebida alcoólica', 'bebidas alcoólicas', 'cerveja', 'cachaça', 'drink',
  'funcionamento de bares', 'funcionamento de restaurantes', 'horário de funcionamento',
  'alvará', 'licença de funcionamento', 'vigilância sanitária', 'inspeção sanitária',
  'taxa de turismo', 'turismo', 'turístico', 'turística', 'hotel', 'hotéis', 'hospedagem',
  'evento', 'eventos', 'show', 'shows', 'festival', 'festivais', 'feira gastronômica',
  'food truck', 'ambulante', 'comércio ambulante', 'uso de calçada', 'calçada',
  'parklet', 'mesa e cadeira', 'mesas e cadeiras', 'cardápio', 'couvert',
  'taxa de serviço', 'consumidor', 'acessibilidade'
];

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

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

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

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function classificarAbraselPb(p) {
  const texto = [p.tipo, p.numero, p.ano, p.autor, p.ementa].join(' ');
  const normalizado = texto.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const termos = ABRASEL_PB_TERMOS.filter(termo => {
    const alvo = termo.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    if (/^[a-z0-9]+$/.test(alvo)) {
      return new RegExp('(^|[^a-z0-9])' + escapeRegExp(alvo) + '([^a-z0-9]|$)').test(normalizado);
    }
    return normalizado.includes(alvo);
  });
  return [...new Set(termos)];
}

function destacarTermos(texto, termos) {
  let html = escapeHtml(texto);
  termos
    .filter(termo => termo.length >= 3)
    .sort((a, b) => b.length - a.length)
    .forEach(termo => {
      html = html.replace(
        new RegExp(escapeRegExp(escapeHtml(termo)), 'gi'),
        match => '<mark style="background:#fff3a3;padding:0 2px;border-radius:2px">' + match + '</mark>'
      );
    });
  return html;
}

function renderAbraselBadge(p) {
  if (!p.abraselPb?.length) return '';
  const termos = p.abraselPb.slice(0, 5).map(escapeHtml).join(', ');
  const extra = p.abraselPb.length > 5 ? ' +' + (p.abraselPb.length - 5) : '';
  return '<div style="margin-top:6px;color:#7a3b00;font-size:11px"><strong>🍽️ Abrasel PB:</strong> ' + termos + extra + '</div>';
}


const CLIENTES_NOMES_PROPRIOS = [
  'FIRJAN', 'Red Bull', 'Sindicerv', 'Boticario',
  'Boticário', 'Grupo Boticario', 'Grupo Boticário', 'O Boticario',
  'O Boticário', 'Abrasel', 'Abrasel PB', 'Abrasel Paraíba',
  'ANBRASEL', 'Ambev', 'Heineken', 'Abralatas',
  'ABIR', 'Coca-Cola', 'Coca Cola', 'Coca-Cola Company',
  'Femsa', 'Solar', 'Grupo Simões', 'Grupo Simoes',
  'Andina', 'CVI', 'iFood', 'Zé Delivery',
  'Ze Delivery', 'Verde Brasil', 'JCRIG', 'Associação dos Cemitérios e Crematórios do Brasil',
  'Associacao dos Cemiterios e Crematorios do Brasil', 'Lalamove', 'Matrix', 'CVC',
  'Rei do Pitaco', 'Maersk', 'Mac Jee', 'Norte Energia',
  'Pacto Pela Fome', 'Sanofi', 'TikTok', 'Minalba',
  'Esmaltec', 'Nacional Gás', 'Nacional Gas', 'Syngenta',
  'Braskem', 'Ypê', 'Ype', 'VTal',
  'V.tal', 'Grupo EPR', 'EPR', 'Natural Energia',
  'DIAGEO', 'Alpargatas', 'Ternium', 'ABRADEE',
  'Eletrobras', 'Eletrobrás', 'MeetKai', 'IPQ',
  'Equatorial', 'EquatorialEnergia', 'Equatorial Energia', 'Equatorial Goiás',
  'Equatorial Goias', 'Equatorial Goiás Distribuidora de Energia', 'Equatorial Goias Distribuidora de Energia', 'CEA Equatorial',
  'CEA Equatorial Energia', 'Equtorial', 'Energisa', 'EnergisaLuz',
  'Neoenergia', 'ENEL', 'Ampla Energia', 'SABESP',
  'COMGAS', 'COMGÁS', 'AEGEA', 'Aegea Saneamento',
  'Águas de Teresina', 'Aguas de Teresina', 'Águas de Timon', 'Aguas de Timon',
  'Águas do Rio', 'Aguas do Rio', 'Águas do Rio 1', 'Águas do Rio 4',
  'Naturgy', 'Agenersa', 'Regenera', 'Comlurb',
  'Hekos', 'Orizon', 'Solvi', 'União Norte',
  'Uniao Norte', 'Vital', 'Eletromidia', 'Eletromídia',
  'AkzoNobel', 'Expedia', 'Hotels.com', 'Vrbo',
  'RTSC', 'Gramado Parks', 'Grupo Wish', 'Huawei',
  'Carrefour', 'Atacadão', 'Atacadao', 'Walmart',
  "Sam's Club", 'Sams Club', 'JBS', 'Friboi',
  'Seara', 'Swift', "Pilgrim's", 'Pilgrims',
  'Wild Fork', 'Ajinomoto', 'Vibra', 'Vibra Energia',
  'BR Distribuidora', 'Raízen', 'Raizen', 'Mindlab',
  'ABVTEX', 'Semove', 'Barcas', 'Seta',
  'Nova Infra', 'BRT'
];

function clientesCitadosNaProposicao(p) {
  const texto = [p.cliente, p.clientes, p.autor, p.autores, p.tipo, p.rotulo, p.titulo, p.identificacao, p.ementa]
    .filter(Boolean)
    .join(' ');
  const achados = [];
  for (const nome of CLIENTES_NOMES_PROPRIOS) {
    const escaped = nome.replace(/[.*+?^\${}()|[\]\\]/g, '\\$&');
    const re = new RegExp('(^|[^A-Za-zÀ-ÿ0-9])' + escaped + '([^A-Za-zÀ-ÿ0-9]|$)', 'i');
    if (re.test(texto) && !achados.some(a => a.toLowerCase() === nome.toLowerCase())) achados.push(nome);
  }
  return achados;
}

function anotarClientesCitados(proposicoes) {
  for (const p of proposicoes || []) {
    const clientes = clientesCitadosNaProposicao(p);
    p.clientesCitados = clientes;
    if (clientes.length && p.ementa && !String(p.ementa).includes('Cliente citado:')) {
      p.ementa = String(p.ementa).trim() + ' | Cliente citado: ' + clientes.join(', ');
    }
  }
}

function mlEscapeHtmlClienteDestaque(valor) {
  return String(valor ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function mlEscapeRegExpClienteDestaque(valor) {
  return String(valor).replace(/[.*+?^\${}()|[\]\\]/g, '\\$&');
}

function mlDestacarTermosClienteEmail(texto, clientes) {
  const nomes = Array.from(new Set([...(clientes || []), ...CLIENTES_NOMES_PROPRIOS]))
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  if (!nomes.length) return mlEscapeHtmlClienteDestaque(texto);

  const regex = new RegExp('(^|[^A-Za-zÀ-ÿ0-9])(' + nomes.map(mlEscapeRegExpClienteDestaque).join('|') + ')(?=[^A-Za-zÀ-ÿ0-9]|$)', 'gi');
  return mlEscapeHtmlClienteDestaque(texto).replace(regex, (match, prefixo, termo) => {
    return prefixo + '<span style="background:#dbeafe;color:#1e3a8a;font-weight:700;border-radius:3px;padding:1px 3px">' + termo + '</span>';
  });
}

function renderizarEmentaCliente(p, renderBase) {
  const texto = String((p && p.ementa) || '-');
  const partes = texto.split(/\s+\|\s+Cliente citado:\s+/i);
  const ementa = renderBase
    ? renderBase(partes[0])
    : mlDestacarTermosClienteEmail(partes[0], p && p.clientesCitados);
  const clientes = partes.length > 1
    ? partes.slice(1).join(' | Cliente citado: ')
    : ((p && p.clientesCitados) || []).join(', ');

  if (!clientes) return ementa;
  return ementa + '<div style="margin-top:6px">' +
    '<span style="display:inline-block;background:#eef6ff;border:1px solid #bfdbfe;color:#1e3a8a;border-radius:999px;padding:3px 8px;font-size:11px;font-weight:700">' +
    'Cliente citado: ' + mlDestacarTermosClienteEmail(clientes, p && p.clientesCitados) +
    '</span></div>';
}

async function enviarEmail(novas) {
  anotarClientesCitados(novas);
  if (process.env.DRY_RUN_EMAIL === '1') {
    console.log(`[DRY_RUN_EMAIL] ${novas.length} proposições novas.`);
    novas.slice(0, 20).forEach(p => console.log(`${p.tipo} ${p.numero}/${p.ano} - ${p.link} - ${renderizarEmentaCliente(p)}`));
    return;
  }
  const nodemailer = require('nodemailer');
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
      ? `<tr><td colspan="5" style="padding:8px;background:#fff8f0;font-size:12px;color:#999;border-top:3px dashed #ddd;text-align:center">⬇️ Requerimentos (${totalReqs})</td></tr>`
      : '';

    const header = `<tr><td colspan="5" style="padding:10px 8px 4px;background:${bgHeader};font-weight:bold;color:${colorHeader};font-size:13px;border-top:2px solid ${borderColor}">${tipo} — ${porTipo[tipo].length} proposição(ões)</td></tr>`;
    const rows = porTipo[tipo].map(p =>
      `<tr>
        <td style="padding:8px;border-bottom:1px solid #eee"><a href="${p.link}" style="color:#1a3a5c;text-decoration:none"><strong>${p.numero}/${p.ano}</strong></a></td>
        <td style="padding:8px;border-bottom:1px solid #eee;font-size:12px;white-space:nowrap">${p.data}</td>
        <td style="padding:8px;border-bottom:1px solid #eee;font-size:12px">${p.autor}</td>
        <td style="padding:8px;border-bottom:1px solid #eee;font-size:12px">${p.abraselPb?.length ? '🍽️ Abrasel PB' : ''}</td>
        <td style="padding:8px;border-bottom:1px solid #eee;font-size:12px">${destacarTermos(p.ementa, p.abraselPb || [])}${renderAbraselBadge(p)}</td>
      </tr>`
    ).join('');

    return separador + header + rows;
  }).join('');

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:900px;margin:0 auto">
      <h2 style="color:#1a3a5c;border-bottom:2px solid #1a3a5c;padding-bottom:8px">
        🏛️ ${CASA_NOME} — ${novas.length} nova(s) proposição(ões)
      </h2>
      <p style="color:#666">Monitoramento automático — ${new Date().toLocaleString('pt-BR')}</p>
      <table style="width:100%;border-collapse:collapse;font-size:14px">
        <thead>
          <tr style="background:#1a3a5c;color:white">
            <th style="padding:10px;text-align:left">Número/Ano</th>
            <th style="padding:10px;text-align:left">Data</th>
            <th style="padding:10px;text-align:left">Autor</th>
            <th style="padding:10px;text-align:left">Interesse</th>
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
    from: `"Monitor ${CASA_NOME}" <${EMAIL_REMETENTE}>`,
    to: EMAIL_DESTINO,
    subject: `🏛️ ${EMAIL_LOCALIDADE}: ${novas.length} nova(s) proposição(ões) — ${new Date().toLocaleDateString('pt-BR')}`,
    html,
  });

  console.log(`✅ Email enviado com ${novas.length} proposições novas (${totalReqs} REQs).`);
}

async function buscarPagina(ano, page, tipoId = null) {
  let url = `${API_BASE}/materia/materialegislativa/?ano=${ano}&page=${page}&page_size=100`;
  if (tipoId) url += `&tipo=${tipoId}`;

  for (let tentativa = 1; tentativa <= 4; tentativa++) {
    const response = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'Mozilla/5.0 (compatible; MonitorLegislativo/1.0; +https://monitorlegislativo.com.br)',
      },
    });

    if (response.ok) return await response.json();

    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable || tentativa === 4) {
      throw new Error(`Erro na API (página ${page}${tipoId ? `, tipo ${tipoId}` : ''}): ${response.status}`);
    }

    const retryAfter = Number(response.headers.get('retry-after') || 0);
    const esperaMs = retryAfter > 0 ? retryAfter * 1000 : tentativa * 10000;
    console.warn(`⚠️ API retornou ${response.status}; nova tentativa em ${Math.round(esperaMs / 1000)}s (${tentativa}/4)`);
    await sleep(esperaMs);
  }
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
    await sleep(1500);
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
    await sleep(1500);
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

  const normalizada = {
    id: p.id,
    tipo,
    numero: p.numero || '-',
    ano: p.ano || '-',
    link: `${MATERIA_BASE}/${p.id}`,
    autor,
    data: p.data_apresentacao || '-',
    ementa: String(p.ementa || '-').replace(/\s+/g, ' ').trim() || '-',
  };
  normalizada.abraselPb = classificarAbraselPb(normalizada);
  return normalizada;
}

(async () => {
  console.log('🚀 Iniciando monitor CMJP (João Pessoa)...');
  console.log(`⏰ ${new Date().toLocaleString('pt-BR')}`);

  const estado = carregarEstado();
  const idsVistos = new Set(estado.proposicoes_vistas);

  const proposicoesRaw = await buscarProposicoes();

  if (proposicoesRaw.length === 0) {
    throw new Error('Nenhuma proposição encontrada. Falha provável de coleta/API; workflow deve ficar vermelho.');
  }

  const proposicoes = proposicoesRaw.map(normalizarProposicao);
  console.log(`📊 Total normalizado: ${proposicoes.length}`);

  const novas = proposicoes.filter(p => !idsVistos.has(p.id));
  console.log(`🆕 Proposições novas: ${novas.length}`);

  if (process.env.DRY_RUN_EMAIL === '1') {
    await enviarEmail(novas);
    console.log('DRY_RUN_EMAIL=1 — estado preservado sem alterações.');
    return;
  }

  if (novas.length > 0) {
    // Ordena: principais primeiro (por tipo regimental), REQ no fim
    const prioridade = [
      'VETO', 'MEDIDA PROVISÓRIA', 'PROPOSTA DE EMENDA À LEI ORGÂNICA',
      'PROJETO DE LEI COMPLEMENTAR', 'PROJETO DE LEI ORDINÁRIA',
      'PROJETO DE RESOLUÇÃO', 'PROJETO DE DECRETO LEGISLATIVO', 'INDICAÇÃO'
    ];
    novas.sort((a, b) => {
      const prioridade = [
        'VETO', 'MEDIDA PROVISÓRIA', 'PROPOSTA DE EMENDA À LEI ORGÂNICA',
        'PROJETO DE LEI COMPLEMENTAR', 'PROJETO DE LEI ORDINÁRIA',
        'PROJETO DE RESOLUÇÃO', 'PROJETO DE DECRETO LEGISLATIVO', 'INDICAÇÃO'
      ];
      const aIdx = prioridade.indexOf(a.tipo);
      const bIdx = prioridade.indexOf(b.tipo);
      const aReq = a.tipo.startsWith('REQ');
      const bReq = b.tipo.startsWith('REQ');

      // REQ sempre no fim
      if (aReq !== bReq) return aReq ? 1 : -1;
      // Tipos principais: ordem regimental
      if (aIdx !== -1 && bIdx !== -1) {
        if (aIdx !== bIdx) return aIdx - bIdx;
        // Mesmo tipo: número decrescente (mais recente primeiro)
        return Number(b.numero) - Number(a.numero);
      }
      if (aIdx !== -1) return -1;
      if (bIdx !== -1) return 1;
      // Outros tipos: alfabético, depois número decrescente
      if (a.tipo < b.tipo) return -1;
      if (a.tipo > b.tipo) return 1;
      return Number(b.numero) - Number(a.numero);
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
