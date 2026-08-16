require('dotenv').config();

const fs = require('fs');
const path = require('path');
const express = require('express');
const axios = require('axios');
const Anthropic = require('@anthropic-ai/sdk');

const {
  ANTHROPIC_API_KEY,
  CLAUDE_MODEL = 'claude-sonnet-4-5',
  WHATSAPP_TOKEN,
  WHATSAPP_PHONE_NUMBER_ID,
  WHATSAPP_VERIFY_TOKEN,
  GRAPH_API_VERSION = 'v21.0',
  PORT = 3000,
  // Caminho para um arquivo .md/.txt com o prompt completo (persona/playbook comercial).
  // Se não existir, cai no SYSTEM_PROMPT (env var) e, por fim, num prompt genérico.
  SYSTEM_PROMPT_FILE = path.join(__dirname, 'prompts', 'damaface-consultor-comercial.md'),
  SYSTEM_PROMPT: SYSTEM_PROMPT_ENV,
  // Número (formato internacional, só dígitos, ex: 5516999998888) para onde o bot
  // avisa quando um atendimento é pausado para um humano assumir. Opcional.
  ADMIN_PHONE_NUMBER,
  // Segredo simples para proteger o endpoint de reativar um atendimento pausado.
  // Se não definido, o endpoint /admin/unpause fica desabilitado.
  ADMIN_SECRET,
} = process.env;

function loadSystemPrompt() {
  try {
    if (SYSTEM_PROMPT_FILE && fs.existsSync(SYSTEM_PROMPT_FILE)) {
      const content = fs.readFileSync(SYSTEM_PROMPT_FILE, 'utf8').trim();
      if (content) {
        console.log(`[config] System prompt carregado de: ${SYSTEM_PROMPT_FILE}`);
        return content;
      }
    }
  } catch (err) {
    console.warn(`[config] Falha ao ler SYSTEM_PROMPT_FILE (${SYSTEM_PROMPT_FILE}):`, err.message);
  }
  if (SYSTEM_PROMPT_ENV) {
    console.log('[config] System prompt carregado da variável de ambiente SYSTEM_PROMPT');
    return SYSTEM_PROMPT_ENV;
  }
  console.log('[config] Usando system prompt genérico padrão (nenhum arquivo/env encontrado)');
  return 'Você é um assistente prestativo respondendo pelo WhatsApp. Seja claro, direto e use uma linguagem natural de conversa.';
}

const SYSTEM_PROMPT = loadSystemPrompt();

// Checagem básica das variáveis obrigatórias antes de subir o servidor
const required = {
  ANTHROPIC_API_KEY,
  WHATSAPP_TOKEN,
  WHATSAPP_PHONE_NUMBER_ID,
  WHATSAPP_VERIFY_TOKEN,
};
for (const [key, value] of Object.entries(required)) {
  if (!value) {
    console.error(`[config] Variável de ambiente ausente: ${key}. Confira seu arquivo .env`);
    process.exit(1);
  }
}

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
const app = express();
app.use(express.json());

// Histórico de conversa em memória por número de telefone.
// Simples e suficiente para começar; some quando o processo reinicia.
// Para produção séria, troque por Redis/Postgres/etc.
const conversations = new Map();
const MAX_HISTORY_MESSAGES = 20; // limite para não estourar contexto/custo

// Números pausados: o bot para de responder automaticamente para esse lead
// até um humano reativar (via /admin/unpause). Some quando o processo reinicia.
const pausedConversations = new Set();
const PAUSE_TAG = '[[PAUSAR]]';

function getHistory(phone) {
  if (!conversations.has(phone)) {
    conversations.set(phone, []);
  }
  return conversations.get(phone);
}

function pushToHistory(phone, role, content) {
  const history = getHistory(phone);
  history.push({ role, content });
  if (history.length > MAX_HISTORY_MESSAGES) {
    history.splice(0, history.length - MAX_HISTORY_MESSAGES);
  }
}

// --- 1) Verificação do webhook (GET) exigida pela Meta na hora de cadastrar a URL ---
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === WHATSAPP_VERIFY_TOKEN) {
    console.log('[webhook] Verificação OK');
    return res.status(200).send(challenge);
  }
  console.warn('[webhook] Falha na verificação (token não confere)');
  return res.sendStatus(403);
});

// --- 2) Recebimento de mensagens (POST) ---
app.post('/webhook', async (req, res) => {
  // Responde 200 imediatamente: a Meta espera resposta rápida e reenvia
  // o evento se demorar/der erro. O processamento continua async abaixo.
  res.sendStatus(200);

  try {
    const entry = req.body.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const message = value?.messages?.[0];

    if (!message) {
      // Pode ser um evento de status (entregue/lido), não uma mensagem nova
      return;
    }

    const from = message.from; // número do usuário, formato internacional sem "+"
    const contactName = value?.contacts?.[0]?.profile?.name || 'usuário';

    if (message.type !== 'text') {
      await sendWhatsAppMessage(
        from,
        'No momento eu só consigo ler mensagens de texto. Pode reescrever sua pergunta em texto?'
      );
      return;
    }

    const userText = message.text.body;
    console.log(`[msg] ${contactName} (${from}): ${userText}`);

    await markAsRead(message.id);

    if (pausedConversations.has(from)) {
      // Atendimento pausado para esse lead: só registra o histórico para
      // contexto, mas não chama o Claude nem responde automaticamente.
      // Um humano assume a conversa por fora até reativar via /admin/unpause.
      pushToHistory(from, 'user', userText);
      console.log(`[pausado] ${from} mandou mensagem mas o bot está pausado para esse lead, ignorando resposta automática.`);
      return;
    }

    // Se a mensagem veio de um anúncio "clique para WhatsApp" (Meta Ads),
    // o payload traz "referral" com dados do anúncio. Usamos isso só na
    // primeira mensagem da conversa para o Claude já saber de onde veio o lead.
    const referral = message.referral;
    const isNewConversation = !conversations.has(from) || getHistory(from).length === 0;
    if (referral && isNewConversation) {
      const adInfo = [
        referral.headline && `Título do anúncio: "${referral.headline}"`,
        referral.body && `Texto: "${referral.body}"`,
        referral.source_id && `ID da campanha/anúncio: ${referral.source_id}`,
      ]
        .filter(Boolean)
        .join(' | ');
      console.log(`[referral] ${from} veio de um anúncio: ${adInfo}`);
      pushToHistory(
        from,
        'user',
        `[Contexto interno — não é uma mensagem do lead, não responda a esta linha diretamente: o lead chegou clicando em um anúncio. ${adInfo}. Use isso para direcionar a conversa para o procedimento certo desde a primeira resposta.]`
      );
      pushToHistory(from, 'assistant', 'Entendido, vou considerar isso na condução da conversa.');
    }

    const reply = await askClaude(from, userText);

    const shouldPause = reply.includes(PAUSE_TAG);
    const cleanReply = reply.replace(PAUSE_TAG, '').trim();

    await sendWhatsAppMessage(from, cleanReply);
    console.log(`[reply] -> ${from}: ${cleanReply}`);

    if (shouldPause) {
      pausedConversations.add(from);
      console.log(`[pausado] Atendimento de ${from} (${contactName}) pausado para um humano assumir.`);
      if (ADMIN_PHONE_NUMBER) {
        const adminMsg = `⏸️ Atendimento pausado\nLead: ${contactName} (${from})\nÚltima mensagem do lead: "${userText}"\nÚltima resposta do bot: "${cleanReply}"`;
        sendWhatsAppMessage(ADMIN_PHONE_NUMBER, adminMsg).catch((err) =>
          console.warn('[admin-notify] falhou:', err.response?.data || err.message)
        );
      }
    }
  } catch (err) {
    console.error('[webhook] Erro ao processar mensagem:', err.response?.data || err.message);
  }
});

// --- Chama o Claude com o histórico da conversa ---
async function askClaude(phone, userText) {
  pushToHistory(phone, 'user', userText);

  const response = await anthropic.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: getHistory(phone),
  });

  const textBlock = response.content.find((block) => block.type === 'text');
  const replyText = textBlock?.text?.trim() || 'Desculpe, não consegui gerar uma resposta agora.';

  pushToHistory(phone, 'assistant', replyText);
  return replyText;
}

// --- Envia mensagem de texto via WhatsApp Cloud API ---
async function sendWhatsAppMessage(to, text) {
  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${WHATSAPP_PHONE_NUMBER_ID}/messages`;

  await axios.post(
    url,
    {
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: text, preview_url: false },
    },
    { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } }
  );
}

// --- Marca a mensagem recebida como lida (dois tiquinhos azuis) ---
async function markAsRead(messageId) {
  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${WHATSAPP_PHONE_NUMBER_ID}/messages`;
  try {
    await axios.post(
      url,
      { messaging_product: 'whatsapp', status: 'read', message_id: messageId },
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } }
    );
  } catch (err) {
    // Não é crítico se falhar, só loga
    console.warn('[markAsRead] falhou:', err.response?.data || err.message);
  }
}

app.get('/', (_req, res) => {
  res.send('Claude WhatsApp Bot está rodando.');
});

// --- Endpoint manual para reativar o bot num atendimento pausado ---
// Uso: GET /admin/unpause?phone=5516999998888&secret=SEU_ADMIN_SECRET
app.get('/admin/unpause', (req, res) => {
  if (!ADMIN_SECRET) {
    return res.status(404).send('Endpoint desabilitado (defina ADMIN_SECRET para habilitar).');
  }
  const { phone, secret } = req.query;
  if (secret !== ADMIN_SECRET) {
    return res.status(403).send('Segredo inválido.');
  }
  if (!phone) {
    return res.status(400).send('Informe ?phone=numero');
  }
  const wasPaused = pausedConversations.delete(phone);
  console.log(`[admin] Reativação solicitada para ${phone}. Estava pausado: ${wasPaused}`);
  return res.send(wasPaused ? `Atendimento de ${phone} reativado.` : `${phone} não estava pausado.`);
});

// --- Endpoint para listar quais atendimentos estão pausados agora ---
app.get('/admin/paused', (req, res) => {
  if (!ADMIN_SECRET) {
    return res.status(404).send('Endpoint desabilitado (defina ADMIN_SECRET para habilitar).');
  }
  if (req.query.secret !== ADMIN_SECRET) {
    return res.status(403).send('Segredo inválido.');
  }
  return res.json({ paused: Array.from(pausedConversations) });
});

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
  console.log(`Webhook: http://localhost:${PORT}/webhook`);
});
