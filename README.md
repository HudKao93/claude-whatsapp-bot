# Claude WhatsApp Bot

Bot de WhatsApp usando a **WhatsApp Cloud API oficial** (Meta) com o **Claude** (Anthropic) como cérebro das respostas.

---

## Visão geral do fluxo

1. Alguém manda mensagem para o seu número de WhatsApp Business.
2. A Meta envia essa mensagem para o seu servidor via **webhook** (POST).
3. Seu servidor (`server.js`) pega o texto, manda para o Claude.
4. O Claude responde, e seu servidor devolve a resposta pelo WhatsApp.

---

## Passo 1 — Gerar a chave de API da Anthropic (Claude)

1. Acesse **https://console.anthropic.com** e crie uma conta (ou faça login).
2. No menu lateral, vá em **Settings → API Keys**.
3. Clique em **Create Key**, dê um nome (ex: `whatsapp-bot`) e copie a chave gerada (começa com `sk-ant-...`).
   - Guarde em local seguro: ela só é mostrada uma vez.
4. Você também vai precisar adicionar créditos/forma de pagamento na aba **Billing**, já que o uso da API é cobrado por token (não faz parte da assinatura do app Claude).

Essa chave vai no `.env` como `ANTHROPIC_API_KEY`.

---

## Passo 2 — Configurar o WhatsApp Business API na Meta

Essa é a parte mais burocrática, mas só precisa ser feita uma vez.

### 2.1. Criar o app na Meta for Developers
1. Acesse **https://developers.facebook.com/apps** e faça login com uma conta Facebook.
2. Clique em **Criar app** → escolha o tipo **"Outro"** → depois **"Empresa"**.
3. Dê um nome ao app e associe a um **Business Manager** (crie um se não tiver, é gratuito).
4. No painel do app, encontre o produto **WhatsApp** e clique em **Configurar/Set up**.

### 2.2. Pegar as credenciais de teste
Na tela **WhatsApp → Início rápido (API Setup)** você vai ver:
- Um **número de teste temporário** da Meta (funciona por 90 dias, só pode mandar mensagem para até 5 números verificados — bom para validar o bot).
- Um **token de acesso temporário** (válido por 24h — depois você troca por um permanente, veja 2.4).
- O **Phone Number ID** (um número longo, é o `WHATSAPP_PHONE_NUMBER_ID`).

Para usar seu **número dedicado de verdade** (não o de teste da Meta):
- Em **WhatsApp → API Setup**, clique em **Adicionar número de telefone**.
- Siga o fluxo: nome do perfil comercial, categoria, e verificação por SMS/chamada no número que você separou para o bot.
- ⚠️ Esse número **não pode estar ativo no app comum do WhatsApp** ao mesmo tempo — ele passa a ser exclusivo da API.

### 2.3. Configurar o Webhook
1. Ainda no app, vá em **WhatsApp → Configuration**.
2. Em **Webhook**, clique em **Edit** e informe:
   - **Callback URL**: `https://SEU-DOMINIO/webhook` (a URL pública do seu servidor — veja Passo 3 sobre deploy).
   - **Verify token**: qualquer string que você inventar (ex: `meu-token-secreto`) — precisa ser **idêntica** à variável `WHATSAPP_VERIFY_TOKEN` do seu `.env`.
3. Clique em **Verify and Save**. A Meta vai fazer uma requisição GET no seu servidor para confirmar — é exatamente o que o endpoint `GET /webhook` do `server.js` responde.
4. Depois de verificado, marque o campo **`messages`** na lista de "Webhook fields" para começar a receber as mensagens recebidas.

### 2.4. Gerar um token permanente (para não expirar em 24h)
1. No Business Manager, vá em **Configurações do negócio → Usuários do sistema (System Users)**.
2. Crie um **System User** com papel de administrador.
3. Vincule esse usuário ao seu app WhatsApp e gere um **token de acesso permanente**, com a permissão `whatsapp_business_messaging` (e `whatsapp_business_management` se for gerenciar números por API também).
4. Use esse token no lugar do temporário em `WHATSAPP_TOKEN`.

---

## Passo 3 — Rodar o bot

### 3.1. Instalar dependências
```bash
npm install
```

### 3.2. Configurar variáveis de ambiente
```bash
cp .env.example .env
```
Edite o `.env` e preencha:
- `ANTHROPIC_API_KEY` — do Passo 1
- `WHATSAPP_TOKEN` — do Passo 2.2 ou 2.4
- `WHATSAPP_PHONE_NUMBER_ID` — do Passo 2.2
- `WHATSAPP_VERIFY_TOKEN` — a string que você inventou no Passo 2.3
- `SYSTEM_PROMPT` — personalize como o bot deve se comportar (opcional)

### 3.3. Rodar localmente para testar
```bash
npm start
```
O servidor sobe em `http://localhost:3000`. Só que a Meta precisa de uma URL **pública** (HTTPS) para mandar os webhooks — use o **ngrok** para testar localmente antes de colocar no seu servidor final:
```bash
npx ngrok http 3000
```
Copie a URL HTTPS gerada (ex: `https://abcd1234.ngrok-free.app`) e use `https://abcd1234.ngrok-free.app/webhook` como Callback URL no Passo 2.3.

### 3.4. Deploy no seu servidor/hospedagem definitiva
Como você já tem um servidor/hospedagem, os passos gerais são:
1. Suba os arquivos do projeto (exceto `node_modules` e `.env` — use `.gitignore` incluído).
2. No servidor: `npm install --omit=dev` e depois `npm start` (ou use um gerenciador de processo como **pm2** para manter rodando: `pm2 start server.js --name claude-whatsapp`).
3. Garanta que a porta configurada (`PORT`, padrão 3000) esteja exposta publicamente via HTTPS — normalmente com um proxy reverso (nginx/Caddy) na frente, ou a própria plataforma (Railway/Render) já expõe uma URL HTTPS automaticamente.
4. Atualize a **Callback URL** do webhook na Meta (Passo 2.3) para a URL final de produção, trocando a do ngrok.

---

## Passo 4 — Testar

1. Pelo celular, mande uma mensagem de WhatsApp para o número configurado.
2. No terminal do servidor você deve ver os logs `[msg]` (mensagem recebida) e `[reply]` (resposta enviada).
3. A resposta gerada pelo Claude deve chegar no WhatsApp em poucos segundos.

Se não chegar nada, confira nesta ordem:
- O webhook está com status "verificado" no painel da Meta?
- O campo `messages` está marcado como inscrito (subscribed)?
- O token da WhatsApp API não expirou (tokens temporários duram 24h)?
- Os logs do servidor mostram algum erro de autenticação (`401`)? Confira as chaves no `.env`.

---

## Limitações e próximos passos

- **Histórico em memória**: as conversas ficam guardadas em RAM (`Map` no código) e são perdidas se o servidor reiniciar. Para algo mais robusto, troque por um banco (Redis, Postgres, etc.).
- **Só texto**: mensagens de áudio, imagem ou documento não são processadas — o bot avisa que só entende texto. Dá para expandir usando transcrição de áudio e visão do Claude.
- **Janela de 24h da Meta**: fora da janela de 24h desde a última mensagem do usuário, você só pode responder com "message templates" pré-aprovados pela Meta — isso não afeta conversas normais iniciadas pelo usuário.
- **Custo**: cada mensagem gera uma chamada de API cobrada por token (veja preços em https://www.anthropic.com/pricing).
