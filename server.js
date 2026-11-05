import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import pino from 'pino';
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} from '@whiskeysockets/baileys';

const PORT = Number(process.env.PORT || 3000);
const AGENTE_URL =
  process.env.AGENTE_URL || 'https://xhu56j4zkwooh8hq9hy5.helloreaddy.com/functions/v1/wpp-agente';
const AGENTE_TOKEN = process.env.WPP_AGENT_TOKEN || '';
const INSTANCIA_PADRAO = process.env.WPP_INSTANCE || '';

const logger = pino({ level: process.env.LOG_LEVEL || 'warn' });

function resolveAuthDir() {
  const preferido = process.env.WPP_AUTH_DIR || path.join('/var/data', 'auth');
  try {
    fs.mkdirSync(preferido, { recursive: true });
    fs.accessSync(preferido, fs.constants.W_OK);
    return preferido;
  } catch {
    const alternativa = path.join(process.cwd(), '.auth');
    fs.mkdirSync(alternativa, { recursive: true });
    return alternativa;
  }
}

const AUTH_DIR = resolveAuthDir();
const MAX_TENTATIVAS = 6;

const estado = {
  sock: null,
  conectado: false,
  iniciando: false,
  paradaManual: false,
  qr: null,
  qrAtualizadoEm: null,
  numero: null,
  nome: null,
  instancia: INSTANCIA_PADRAO,
  ultimoErro: null,
  iniciadoEm: new Date().toISOString(),
  mensagensRecebidas: 0,
  respostasEnviadas: 0,
  geracao: 0,
  tentativas: 0,
  timerReconexao: null,
};

let promessaInicio = null;

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'content-type, x-wpp-token');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  return next();
});

function extrairTexto(message) {
  if (!message) return '';
  let interno = message;
  if (interno.ephemeralMessage?.message) interno = interno.ephemeralMessage.message;
  if (interno.viewOnceMessage?.message) interno = interno.viewOnceMessage.message;
  if (interno.viewOnceMessageV2?.message) interno = interno.viewOnceMessageV2.message;
  if (interno.documentWithCaptionMessage?.message) interno = interno.documentWithCaptionMessage.message;
  return (
    interno.conversation ||
    interno.extendedTextMessage?.text ||
    interno.imageMessage?.caption ||
    interno.videoMessage?.caption ||
    interno.documentMessage?.caption ||
    interno.buttonsResponseMessage?.selectedDisplayText ||
    interno.listResponseMessage?.title ||
    ''
  );
}

function somenteDigitos(valor) {
  return String(valor ?? '').replace(/\D/g, '');
}

function arquivoCredenciais() {
  return path.join(AUTH_DIR, 'creds.json');
}

function credenciaisValidas() {
  try {
    const arquivo = arquivoCredenciais();
    if (!fs.existsSync(arquivo)) return false;
    const bruto = fs.readFileSync(arquivo, 'utf8').trim();
    if (!bruto) return false;
    const dados = JSON.parse(bruto);
    if (!dados || typeof dados !== 'object') return false;
    if (dados.registered === false) return false;
    if (!dados.noiseKey || !dados.signedIdentityKey) return false;
    return true;
  } catch {
    return false;
  }
}

function statusConexao() {
  if (estado.conectado) return 'connected';
  if (estado.qr) return 'qr';
  if (estado.iniciando || estado.sock) return 'connecting';
  return 'disconnected';
}

function statusResumido() {
  const conectado = estado.conectado;
  return {
    ok: true,
    conectado,
    status: statusConexao(),
    qr: conectado ? null : estado.qr,
    qr_atualizado_em: estado.qrAtualizadoEm,
    numero: estado.numero,
    nome: estado.nome,
    instancia: estado.instancia || null,
    erro: estado.ultimoErro,
    iniciando: estado.iniciando,
    aguardando_qr: Boolean(estado.qr),
    tentativas: estado.tentativas,
    sessao_salva: credenciaisValidas(),
    mensagens_recebidas: estado.mensagensRecebidas,
    respostas_enviadas: estado.respostasEnviadas,
  };
}

async function falarComAgente(payload, timeoutMs = 25000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
    if (AGENTE_TOKEN) headers['x-wpp-token'] = AGENTE_TOKEN;
    const resposta = await fetch(AGENTE_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const texto = await resposta.text();
    try {
      return texto ? JSON.parse(texto) : null;
    } catch {
      return { ok: false, message: texto.slice(0, 300) };
    }
  } catch (erro) {
    return { ok: false, message: erro?.message || 'Falha ao falar com o agente do painel.' };
  } finally {
    clearTimeout(timer);
  }
}

async function enviarTexto(numero, texto) {
  if (!estado.sock || !estado.conectado) {
    throw new Error('O WhatsApp nao esta conectado.');
  }
  const digitos = somenteDigitos(numero);
  if (digitos.length < 8) throw new Error('Numero de destino invalido.');
  const jid = `${digitos}@s.whatsapp.net`;
  await estado.sock.sendMessage(jid, { text: String(texto) });
  return jid;
}

async function processarMensagemRecebida(msg) {
  try {
    if (!msg?.message || msg.key?.fromMe) return;
    const remoto = msg.key?.remoteJid || '';
    if (!remoto || remoto.endsWith('@g.us') || remoto === 'status@broadcast') return;

    const texto = extrairTexto(msg.message).trim();
    if (!texto) return;

    const numero = somenteDigitos(remoto.split('@')[0]);
    const nome = msg.pushName || '';
    estado.mensagensRecebidas += 1;

    const resposta = await falarComAgente({
      action: 'mensagem_recebida',
      instancia: estado.instancia || undefined,
      instance: estado.instancia || undefined,
      numero,
      phone: numero,
      nome,
      texto,
      mensagem_id: msg.key?.id || undefined,
    });

    if (resposta?.responda && resposta?.resposta) {
      try {
        await enviarTexto(numero, resposta.resposta);
        estado.respostasEnviadas += 1;
      } catch (erro) {
        estado.ultimoErro = `Falha ao enviar resposta automatica: ${erro?.message || 'erro desconhecido'}`;
      }
    }
  } catch (erro) {
    estado.ultimoErro = `Falha ao processar mensagem: ${erro?.message || 'erro desconhecido'}`;
  }
}

function aguardar(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function limparSessao() {
  estado.geracao += 1;
  try {
    fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    fs.mkdirSync(AUTH_DIR, { recursive: true });
  } catch {
    // Se a pasta nao puder ser limpa, a proxima conexao sobrescreve os arquivos.
  }
}

function encerrarSocketAtual() {
  const antigo = estado.sock;
  estado.sock = null;
  if (!antigo) return;
  try {
    antigo.ev.removeAllListeners('connection.update');
    antigo.ev.removeAllListeners('creds.update');
    antigo.ev.removeAllListeners('messages.upsert');
  } catch {
    // Ignora falhas ao remover os ouvintes.
  }
  try {
    antigo.end?.(undefined);
  } catch {
    // Ignora falhas ao encerrar o socket.
  }
}

function cancelarReconexao() {
  if (estado.timerReconexao) {
    clearTimeout(estado.timerReconexao);
    estado.timerReconexao = null;
  }
}

function agendarReconexao(delayMs) {
  if (estado.paradaManual) return;
  cancelarReconexao();
  estado.timerReconexao = setTimeout(() => {
    estado.timerReconexao = null;
    void iniciarConexao();
  }, delayMs);
}

function tratarAtualizacao(sock, geracao, update) {
  if (geracao !== estado.geracao) return;
  const { connection, lastDisconnect, qr } = update || {};

  if (qr) {
    estado.qr = qr;
    estado.qrAtualizadoEm = new Date().toISOString();
    estado.conectado = false;
    estado.ultimoErro = null;
  }

  if (connection === 'open') {
    estado.conectado = true;
    estado.qr = null;
    estado.ultimoErro = null;
    estado.tentativas = 0;
    const bruto = sock.user?.id || '';
    estado.numero = somenteDigitos(String(bruto).split(':')[0].split('@')[0]) || null;
    estado.nome = sock.user?.name || null;
    return;
  }

  if (connection !== 'close') return;

  estado.conectado = false;
  estado.qr = null;
  estado.qrAtualizadoEm = null;
  estado.numero = null;
  estado.nome = null;

  const codigo = lastDisconnect?.error?.output?.statusCode;
  const motivo = String(lastDisconnect?.error?.message || '');
  const encerradaNoCelular =
    codigo === DisconnectReason.loggedOut ||
    codigo === 401 ||
    codigo === 403 ||
    codigo === 405 ||
    /logged out|loggedout|invalid.*session|session.*invalid/i.test(motivo);

  setTimeout(() => {
    if (geracao === estado.geracao) encerrarSocketAtual();
  }, 0);

  if (estado.paradaManual) return;

  if (encerradaNoCelular) {
    limparSessao();
    estado.tentativas = 0;
    estado.ultimoErro =
      'A sessao foi encerrada no celular. Apagando os dados antigos e gerando um QR Code novo automaticamente...';
    agendarReconexao(1200);
    return;
  }

  estado.tentativas += 1;
  estado.ultimoErro = motivo || 'A conexao caiu. Tentando reconectar automaticamente.';

  if (estado.tentativas >= MAX_TENTATIVAS) {
    estado.tentativas = 0;
    limparSessao();
    estado.ultimoErro =
      'A sessao anterior nao pode ser reaproveitada. Ela foi apagada e um QR Code novo sera gerado automaticamente.';
    agendarReconexao(2000);
    return;
  }

  agendarReconexao(Math.min(2500 * estado.tentativas, 15000));
}

async function executarInicio() {
  if (estado.conectado) return;
  if (estado.sock && estado.qr) return;
  if (estado.iniciando) return;

  estado.iniciando = true;
  estado.paradaManual = false;
  cancelarReconexao();

  try {
    encerrarSocketAtual();
    estado.qr = null;
    estado.qrAtualizadoEm = null;
    estado.geracao += 1;
    const geracao = estado.geracao;

    fs.mkdirSync(AUTH_DIR, { recursive: true });
    const { state: authState, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

    let versao;
    try {
      const info = await fetchLatestBaileysVersion();
      versao = info?.version;
    } catch {
      versao = undefined;
    }

    const sock = makeWASocket({
      version: versao,
      auth: authState,
      logger,
      printQRInTerminal: false,
      markOnlineOnConnect: true,
      syncFullHistory: false,
      browser: ['NexPlay Painel', 'Chrome', '1.0.0'],
      getMessage: async () => undefined,
    });

    estado.sock = sock;

    sock.ev.on('creds.update', async () => {
      if (geracao !== estado.geracao) return;
      try {
        await saveCreds();
      } catch {
        // Uma falha ao gravar credenciais nao deve derrubar o servidor.
      }
    });

    sock.ev.on('connection.update', (update) => {
      try {
        tratarAtualizacao(sock, geracao, update);
      } catch (erro) {
        estado.ultimoErro = erro?.message || 'Falha ao tratar o estado da conexao.';
      }
    });

    sock.ev.on('messages.upsert', async (evento) => {
      if (geracao !== estado.geracao) return;
      if (evento?.type && evento.type !== 'notify') return;
      for (const msg of evento?.messages || []) {
        await processarMensagemRecebida(msg);
      }
    });
  } catch (erro) {
    estado.ultimoErro = erro?.message || 'Nao foi possivel iniciar a conexao.';
    estado.sock = null;
    estado.tentativas += 1;
    // Credenciais corrompidas impedem qualquer conexao nova: apagamos e recomecamos limpo.
    if (estado.tentativas >= 1) {
      limparSessao();
    }
    if (estado.tentativas >= MAX_TENTATIVAS) {
      estado.tentativas = 0;
    }
    agendarReconexao(Math.min(3000 * Math.max(estado.tentativas, 1), 15000));
  } finally {
    estado.iniciando = false;
  }
}

function iniciarConexao() {
  if (promessaInicio) return promessaInicio;
  promessaInicio = executarInicio().finally(() => {
    promessaInicio = null;
  });
  return promessaInicio;
}

async function aguardarQr(limiteMs = 20000) {
  const inicio = Date.now();
  while (Date.now() - inicio < limiteMs) {
    if (estado.qr || estado.conectado) break;
    await aguardar(400);
  }
}

function pastaPersistenteOk() {
  try {
    const teste = path.join(AUTH_DIR, `.teste-${Date.now()}`);
    fs.writeFileSync(teste, 'ok');
    fs.unlinkSync(teste);
    return true;
  } catch {
    return false;
  }
}

async function desconectarTudo() {
  estado.paradaManual = true;
  cancelarReconexao();
  limparSessao();

  const sock = estado.sock;
  if (sock) {
    try {
      await Promise.race([sock.logout(), aguardar(6000)]);
    } catch {
      // A sessao pode ja estar invalida; seguimos com a limpeza.
    }
  }

  encerrarSocketAtual();
  estado.conectado = false;
  estado.qr = null;
  estado.qrAtualizadoEm = null;
  estado.numero = null;
  estado.nome = null;
  estado.ultimoErro = null;
  estado.iniciando = false;
  estado.tentativas = 0;
}

app.get('/', (req, res) => {
  const rotulo =
    statusConexao() === 'connected'
      ? 'conectado'
      : statusConexao() === 'qr'
        ? 'aguardando leitura do QR Code'
        : statusConexao() === 'connecting'
          ? 'iniciando conexao'
          : 'desconectado';
  res.type('html').send(
    `<html><head><meta charset="utf-8"><title>NexPlay WhatsApp</title></head>
     <body style="font-family:sans-serif;padding:32px;line-height:1.6">
     <h1>Servidor do WhatsApp no ar</h1>
     <p>Status: <strong>${rotulo}</strong></p>
     <p>Diagnostico completo: <a href="/api/diagnostico">/api/diagnostico</a></p>
     </body></html>`,
  );
});

app.get('/api/diagnostico', (req, res) => {
  const problemas = [];
  if (!estado.conectado) problemas.push('O WhatsApp ainda nao esta conectado.');
  if (!pastaPersistenteOk()) problemas.push('A pasta da sessao nao aceita escrita. Confira o disco em /var/data.');
  if (estado.ultimoErro) problemas.push(estado.ultimoErro);

  res.json({
    ok: true,
    servico: 'NexPlay WhatsApp Server',
    versao: '1.1.0',
    ...statusResumido(),
    pasta_sessao: AUTH_DIR,
    pasta_persistente: pastaPersistenteOk(),
    permissoes_banco: 'completa',
    agente: AGENTE_URL,
    token_agente: AGENTE_TOKEN ? 'configurado' : 'nao configurado (opcional)',
    iniciado_em: estado.iniciadoEm,
    problemas,
    mensagem:
      problemas.length === 0
        ? 'Tudo pronto: servidor, sessao persistente e comunicacao com o painel funcionando.'
        : 'O servidor esta no ar, mas ainda falta resolver os itens da lista "problemas".',
  });
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, conectado: estado.conectado, status: statusConexao() });
});

app.get('/api/status', (req, res) => {
  res.json(statusResumido());
});

app.get('/api/qr', (req, res) => {
  res.json({ ...statusResumido(), qr: estado.conectado ? null : estado.qr });
});

app.post('/api/conectar', async (req, res) => {
  const corpo = req.body || {};
  const instancia = String(corpo.instancia || corpo.instance || corpo.instanceName || '').trim();
  if (instancia) estado.instancia = instancia;

  if (estado.conectado) {
    return res.json({ ...statusResumido(), mensagem: 'O WhatsApp ja esta conectado.' });
  }

  if (!estado.qr) {
    if (!credenciaisValidas()) {
      limparSessao();
    }
    void iniciarConexao();
    await aguardarQr(20000);
  }

  const status = statusConexao();
  return res.json({
    ...statusResumido(),
    mensagem:
      status === 'qr'
        ? 'QR Code gerado. Leia no seu WhatsApp em Dispositivos conectados.'
        : status === 'connected'
          ? 'WhatsApp conectado.'
          : status === 'connecting'
            ? 'O servidor esta iniciando a sessao. O QR Code aparece em alguns segundos.'
            : 'Nao foi possivel gerar o QR Code agora. Abra /api/diagnostico para ver o motivo.',
  });
});

app.post('/api/reiniciar', async (req, res) => {
  const corpo = req.body || {};
  const instancia = String(corpo.instancia || corpo.instance || corpo.instanceName || '').trim();
  if (instancia) estado.instancia = instancia;

  await desconectarTudo();
  estado.paradaManual = false;
  void iniciarConexao();
  await aguardarQr(20000);

  const status = statusConexao();
  return res.json({
    ...statusResumido(),
    mensagem:
      status === 'qr'
        ? 'Sessao antiga apagada e QR Code novo gerado.'
        : status === 'connecting'
          ? 'Sessao antiga apagada. O servidor esta gerando um QR Code novo.'
          : 'Sessao antiga apagada, mas o QR Code nao saiu agora. Tente novamente em alguns segundos.',
  });
});

app.post('/api/desconectar', async (req, res) => {
  await desconectarTudo();
  res.json({ ...statusResumido(), mensagem: 'WhatsApp desconectado. A sessao foi apagada.' });
});

app.post('/api/enviar', async (req, res) => {
  const corpo = req.body || {};
  const numero = somenteDigitos(
    corpo.numero || corpo.phone || corpo.telefone || corpo.to || corpo.jid || '',
  );
  const texto = String(corpo.mensagem || corpo.message || corpo.text || corpo.body || '').trim();

  if (!numero || !texto) {
    return res.status(400).json({ ok: false, message: 'Informe o numero e a mensagem.' });
  }
  if (!estado.conectado) {
    return res.status(409).json({ ok: false, message: 'O WhatsApp nao esta conectado.' });
  }

  try {
    const jid = await enviarTexto(numero, texto);
    return res.json({ ok: true, jid, mensagem: 'Mensagem enviada.' });
  } catch (erro) {
    return res.status(500).json({ ok: false, message: erro?.message || 'Falha ao enviar a mensagem.' });
  }
});

app.post('/api/agente', async (req, res) => {
  const resposta = await falarComAgente(req.body || {});
  res.json(resposta ?? { ok: false, message: 'Sem resposta do agente.' });
});

process.on('unhandledRejection', (erro) => {
  estado.ultimoErro = `Falha interna tratada: ${erro?.message || 'erro desconhecido'}`;
  console.error('[nexplay] unhandledRejection:', erro?.message || erro);
});

process.on('uncaughtException', (erro) => {
  estado.ultimoErro = `Falha interna tratada: ${erro?.message || 'erro desconhecido'}`;
  console.error('[nexplay] uncaughtException:', erro?.message || erro);
});

app.listen(PORT, '0.0.0.0', () => {
  fs.mkdirSync(AUTH_DIR, { recursive: true });
  console.log(`[nexplay] Servidor do WhatsApp ouvindo na porta ${PORT}`);
  console.log(`[nexplay] Pasta da sessao: ${AUTH_DIR}`);
  console.log(`[nexplay] Agente do painel: ${AGENTE_URL}`);

  if (credenciaisValidas()) {
    console.log('[nexplay] Sessao anterior valida encontrada. Reconectando automaticamente...');
    void iniciarConexao();
  } else {
    limparSessao();
    console.log('[nexplay] Nenhuma sessao valida anterior. Aguardando o painel pedir o QR Code.');
  }
});