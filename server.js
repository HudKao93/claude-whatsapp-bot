require('dotenv').config();

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
  SYSTEM_PROMPT = 'Você é um assistente prestativo respondendo pelo WhatsApp. Seja claro, direto e use uma linguagem natural de conversa.',
} = process.env;

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

    const reply = await askClaude(from, userText);
    await sendWhatsAppMessage(from, reply);

    console.log(`[reply] -> ${from}: ${reply}`);
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

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
  console.log(`Webhook: http://localhost:${PORT}/webhook`);
});
