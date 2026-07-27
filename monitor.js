const fs = require('fs');

const EMAIL_DESTINO = process.env.EMAIL_DESTINO;
const EMAIL_REMETENTE = process.env.EMAIL_REMETENTE;
const EMAIL_SENHA = process.env.EMAIL_SENHA;
const ARQUIVO_ESTADO = 'estado.json';
const RADAR03_URL = process.env.RADAR03_URL || 'https://doe.monitorlegislativo.com.br/controle03/';
const CASA_RADAR03 = process.env.CASA_RADAR03 || 'PB - João Pessoa';
const CONTROLE03_STATE_URL = process.env.CONTROLE03_STATE_URL || new URL('api/state', RADAR03_URL).toString();
const CONTROLE03_API_USER = process.env.CONTROLE03_API_USER || '';
const CONTROLE03_API_PASS = process.env.CONTROLE03_API_PASS || '';
const CONTROLE03_BASIC_AUTH = process.env.CONTROLE03_BASIC_AUTH || '';

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
    if (clientes.length && p.ementa && !(String(p.ementa).includes('Cliente citado:') || String(p.ementa).includes('CLIENTE CITADO:'))) {
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
    return prefixo + '<span style="background:#fff1f2;color:#991b1b;font-weight:800;border:1px solid #fecdd3;border-radius:3px;padding:1px 4px">' + termo + '</span>';
  });
}

function renderizarEmentaCliente(p, renderBase) {
  const texto = String((p && p.ementa) || '-');
  const partes = texto.split(/\s+\|\s+(?:🆘\s*)?CLIENTE CITADO:\s+|\s+\|\s+Cliente citado:\s+/i);
  const ementa = renderBase
    ? renderBase(partes[0])
    : mlDestacarTermosClienteEmail(partes[0], p && p.clientesCitados);
  const clientes = partes.length > 1
    ? partes.slice(1).join(' | Cliente citado: ')
    : ((p && p.clientesCitados) || []).join(', ');

  if (!clientes) return ementa;
  return ementa + '<div style="margin-top:6px">' +
    '<span style="display:inline-block;background:#fff1f2;border:1px solid #fb7185;color:#991b1b;border-radius:999px;padding:4px 9px;font-size:11px;font-weight:900;text-transform:uppercase;letter-spacing:0">' +
    '🆘 CLIENTE CITADO: ' + mlDestacarTermosClienteEmail(clientes, p && p.clientesCitados) +
    '</span></div>';
}


function clientesCitadosResumoEmail(novas) {
  const nomes = [];
  for (const p of novas || []) {
    for (const nome of (Array.isArray(p && p.clientesCitados) ? p.clientesCitados : [])) {
      if (nome && !nomes.some(n => n.toLowerCase() === String(nome).toLowerCase())) nomes.push(String(nome));
    }
  }
  return nomes;
}

function assuntoEmailClienteCitado(novas, assuntoBase) {
  const nomes = clientesCitadosResumoEmail(novas);
  if (!nomes.length) return assuntoBase;
  const lista = nomes.slice(0, 3).join(', ') + (nomes.length > 3 ? ' +' + (nomes.length - 3) : '');
  const base = String(assuntoBase || '');
  return base.startsWith('🆘') ? base : '🆘 Cliente citado: ' + lista + ' | ' + base;
}

function radar03Numero(p) {
  const numero = String(p?.numero ?? p?.numero_proposicao ?? p?.num ?? '').trim();
  const ano = String(p?.ano ?? p?.ano_proposicao ?? '').trim();
  if (!numero) return '';
  if (numero.includes('/') || !ano) return numero;
  return numero + '/' + ano;
}


function radar03NumeroPartes(p) {
  const numeroRaw = String(p?.numero ?? p?.numero_proposicao ?? p?.num ?? '').trim();
  const anoRaw = String(p?.ano ?? p?.ano_proposicao ?? '').trim();
  if (!numeroRaw) return null;

  const match = numeroRaw.match(/^(\d+)\s*\/\s*(\d{2,4})$/);
  const numero = match ? match[1] : numeroRaw;
  const ano = match ? match[2] : anoRaw;
  const numeroInt = parseInt(numero, 10);
  if (!Number.isFinite(numeroInt)) return null;

  return {
    numero,
    numeroInt,
    ano: ano && ano.length === 2 ? '20' + ano : ano,
  };
}


function radar03BlocoEmail(novas) {
  const seen = new Set();
  return (novas || []).map(p => {
    const tipo = String(p?.tipo ?? p?.sigla ?? p?.rotulo ?? '').trim();
    const numero = radar03Numero(p);
    if (!tipo || !numero) return '';
    const row = `${tipo} ${numero}`;
    const key = row.toUpperCase();
    if (seen.has(key)) return '';
    seen.add(key);
    return row;
  }).filter(Boolean).join(' | ');
}

function radar03PrimeiraFonte(novas) {
  const item = (novas || []).find(p => p?.link || p?.url || p?.fonte || p?.projeto_url);
  return item ? String(item.link || item.url || item.fonte || item.projeto_url || '') : '';
}


function radar03TipoControle(tipo) {
  const normal = String(tipo || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .trim();
  const mapa = {
    'PROJETO DE LEI': 'PL', 'PL': 'PL',
    'PROJETO DE LEI COMPLEMENTAR': 'PLC', 'PLC': 'PLC',
    'PROPOSTA DE EMENDA A CONSTITUICAO': 'PEC', 'PEC': 'PEC',
    'PROJETO DE DECRETO LEGISLATIVO': 'PDL', 'PDL': 'PDL',
    'PROJETO DE RESOLUCAO': 'PR', 'PR': 'PR',
    'INDICACAO': 'IND', 'MOCAO': 'MOC', 'REQUERIMENTO': 'REQ', 'REQ.': 'REQ',
    'REQUERIMENTO DE INFORMACAO': 'REQINF', 'RI': 'REQINF', 'VETO': 'VETO',
  };
  return mapa[normal] || String(tipo || '').trim().toUpperCase();
}

function radar03DiaUtilAtual() {
  const w = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Sao_Paulo', weekday: 'short' }).format(new Date());
  const d = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[w] || 0;
  if (d === 0 || d === 6) return 4;
  return Math.max(0, Math.min(4, d - 1));
}

function radar03AuthHeaders() {
  const headers = { 'Content-Type': 'application/json' };
  const token = CONTROLE03_BASIC_AUTH || (
    CONTROLE03_API_USER && CONTROLE03_API_PASS
      ? Buffer.from(CONTROLE03_API_USER + ':' + CONTROLE03_API_PASS).toString('base64')
      : ''
  );
  if (token) headers.Authorization = token.startsWith('Basic ') ? token : 'Basic ' + token;
  return headers;
}

function radar03AgruparNovidades(novas) {
  const porTipo = new Map();
  (novas || []).forEach(p => {
    const tipo = radar03TipoControle(p?.tipo || p?.sigla || p?.rotulo || '');
    const partes = radar03NumeroPartes(p);
    if (!tipo || !partes) return;
    const itemCaptado = {
      tipo,
      numeroInt: partes.numeroInt,
      numero: partes.numero,
      ano: partes.ano || String(p?.ano || ''),
      id: String(p?.id || p?.codigo || p?.projeto_id || p?.id_proposicao || ''),
      ementa: String(p?.ementa || p?.resumo || p?.titulo || '').trim(),
      link: String(p?.link || p?.url || p?.fonte || p?.projeto_url || '').trim(),
      clienteSugestao: Array.isArray(p?.clientesCitados) ? p.clientesCitados.join(', ') : '',
      clienteCitado: Array.isArray(p?.clientesCitados) && p.clientesCitados.length > 0,
      clienteCitadoNomes: Array.isArray(p?.clientesCitados) ? p.clientesCitados.join(', ') : '',
    };
    let atual = porTipo.get(tipo);
    if (!atual) {
      atual = { ...itemCaptado, itens: [] };
      porTipo.set(tipo, atual);
    }
    atual.itens.push(itemCaptado);
    if (partes.numeroInt > atual.numeroInt) {
      atual.numeroInt = partes.numeroInt;
      atual.numero = partes.numero;
      atual.ano = partes.ano || String(p?.ano || '');
      atual.id = itemCaptado.id;
      atual.ementa = itemCaptado.ementa;
      atual.link = itemCaptado.link;
      atual.clienteSugestao = itemCaptado.clienteSugestao;
    }
  });
  return Array.from(porTipo.values()).map(rec => {
    rec.itens.sort((a, b) => a.numeroInt - b.numeroInt);
    return rec;
  });
}

async function sincronizarRadar03(novas) {
  const resumo = radar03AgruparNovidades(novas);
  if (!resumo.length) return;
  try {
    const getResp = await fetch(CONTROLE03_STATE_URL, { headers: radar03AuthHeaders() });
    if (!getResp.ok) throw new Error('GET ' + getResp.status);
    const state = await getResp.json();
    if (!Array.isArray(state.data)) throw new Error('estado central vazio ou inválido');

    const data = state.data;
    let casa = data.find(item => item && item.casa === CASA_RADAR03);
    if (!casa) {
      casa = { casa: CASA_RADAR03, casaId: CASA_RADAR03, regiao: '', responsavel: '', risco: 'media', status: 'A conferir', week: ['off', 'off', 'off', 'off', 'off'], items: [] };
      data.push(casa);
    }
    if (!Array.isArray(casa.items)) casa.items = [];
    if (!Array.isArray(casa.week)) casa.week = ['off', 'off', 'off', 'off', 'off'];
    while (casa.week.length < 5) casa.week.push('off');

    resumo.forEach(rec => {
      const detalhes = [rec];
      const existentesTipo = casa.items.filter(i => radar03TipoControle(i?.tipo || '') === rec.tipo);
      const baseAtual = existentesTipo.reduce((max, i) => {
        const n = Number.parseInt(String(i?.base || i?.mon || 0), 10) || 0;
        return Math.max(max, n);
      }, 0);

      detalhes.forEach(det => {
        let item = casa.items.find(i =>
          (det.id && i?.radar03Id === det.id) ||
          (radar03TipoControle(i?.tipo || '') === det.tipo &&
            Number.parseInt(String(i?.mon || 0), 10) === det.numeroInt &&
            String(i?.link || '') === String(det.link || ''))
        );
        if (!item) {
          item = { tipo: det.tipo, base: baseAtual, mon: det.numeroInt, radar03Id: det.id || '' };
          casa.items.push(item);
        }

        const base = Number.parseInt(String(item.base || baseAtual || 0), 10) || 0;
        item.tipo = det.tipo;
        item.mon = det.numeroInt;
        item.delta = det.numeroInt === base ? 0 : 1;
        item.sentido = det.numeroInt === base ? 'bate com o controle' : 'captado individualmente na fonte';
        item.fluxo = item.delta ? 'nao_consultado' : (item.fluxo || 'revisado');
        item.ementa = det.ementa || item.ementa || '';
        item.link = det.link || item.link || '';
        item.clienteSugestao = det.clienteSugestao || item.clienteSugestao || '';
        item.clienteCitado = Boolean(det.clienteCitado || item.clienteCitado);
        item.clienteCitadoNomes = det.clienteCitadoNomes || item.clienteCitadoNomes || item.clienteSugestao || '';
        item.radar03Id = det.id || item.radar03Id || '';
        item.listaReal03 = true;
      });
    });

    casa.status = 'Atualizar 03';
    casa.week[radar03DiaUtilAtual()] = 'leva';
    if (!Array.isArray(casa.obs03)) casa.obs03 = [];
    casa.obs03.push({
      tipo: CASA_RADAR03,
      situacao: 'novo',
      label: 'Rodada sincronizada automaticamente na 03',
      base: resumo.map(item => item.tipo + ' ' + item.numero + (item.ano ? '/' + item.ano : '')).join(' | '),
      fonte: 'monitor-proposicoes',
      at: new Date().toISOString(),
    });

    const postResp = await fetch(CONTROLE03_STATE_URL, {
      method: 'POST', headers: radar03AuthHeaders(), body: JSON.stringify({ data }),
    });
    if (!postResp.ok) throw new Error('POST ' + postResp.status);
    console.log('✅ Radar 03 sincronizado: ' + CASA_RADAR03 + ' · ' + resumo.map(item => item.tipo + ' ' + item.numero + '/' + item.ano).join(' | '));
  } catch (err) {
    console.warn('⚠️ Não foi possível sincronizar o Radar 03 automaticamente: ' + err.message);
  }
}

function radar03ReviewUrl(novas) {
  const params = new URLSearchParams({
    casa: CASA_RADAR03,
    bloco: radar03AgruparNovidades(novas).map(item => item.tipo + ' ' + item.numero + (item.ano ? '/' + item.ano : '')).join(' | '),
    fonte: radar03PrimeiraFonte(novas),
  });
  return `${RADAR03_URL}?${params.toString()}`;
}

function radar03Escape(valor) {
  return String(valor ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderRadar03EmailButton(novas) {
  const bloco = radar03BlocoEmail(novas);
  if (!bloco) return '';
  return `
    <div style="background:#ecfdf3;border:1px solid #bbf7d0;border-radius:6px;padding:12px 14px;margin:14px 0;color:#14532d;font-size:13px">
      <div style="font-weight:bold;margin-bottom:6px">Radar 03 | Novas Proposições</div>
      <div style="margin-bottom:9px;color:#166534">${radar03Escape(CASA_RADAR03)} · ${radar03Escape(bloco)}</div>
      <a href="${radar03Escape(radar03ReviewUrl(novas))}" style="display:inline-block;background:#166534;color:white;text-decoration:none;border-radius:4px;padding:8px 11px;font-size:12px;font-weight:bold">Revisar no Radar 03</a>
      <span style="font-size:12px;color:#64748b;margin-left:8px">abre preenchido para confirmação</span>
    </div>
  `;
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
      ${renderRadar03EmailButton(novas)}
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
    subject: assuntoEmailClienteCitado(novas, `🏛️ ${EMAIL_LOCALIDADE}: ${novas.length} nova(s) proposição(ões) — ${new Date().toLocaleDateString('pt-BR')}`),
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
    await sincronizarRadar03(novas);
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
