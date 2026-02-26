const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8476184475:AAEka7mj2waSrH1XV4z-PWwuMFxwTVVsbHg';
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

// In-memory storage
const userFilters = {};
const userSubscribed = {};

const EXCHANGES = {
  mexc: 'MEXC', gateio: 'Gate.io', bingx: 'BingX', htx: 'HTX', kucoin: 'KuCoin'
};

const DEX_PLATFORMS = {
  jupiter: { name: 'Jupiter', chain: 'Solana' },
  raydium: { name: 'Raydium', chain: 'Solana' },
  pancakeswap: { name: 'PancakeSwap', chain: 'BSC' },
  quickswap: { name: 'QuickSwap', chain: 'Polygon' },
  uniswap_v3: { name: 'Uniswap V3', chain: 'Arbitrum' },
  traderjoe: { name: 'Trader Joe', chain: 'Avalanche' },
  aerodrome: { name: 'Aerodrome', chain: 'Base' }
};

async function telegramApi(method, data) {
  const url = `${TELEGRAM_API}/${method}`;
  const res = await fetch(url, {
    method: data ? 'POST' : 'GET',
    headers: data ? { 'Content-Type': 'application/json' } : undefined,
    body: data ? JSON.stringify(data) : undefined
  });
  return res.json();
}

async function sendMessage(chatId, text, keyboard) {
  const data = { chat_id: chatId, text, parse_mode: 'HTML' };
  if (keyboard) data.reply_markup = keyboard;
  return telegramApi('sendMessage', data);
}

async function answerCallback(callbackId) {
  return telegramApi('answerCallbackQuery', { callback_query_id: callbackId });
}

const mainKeyboard = {
  inline_keyboard: [
    [{ text: '🔍 Сканировать', callback_data: 'scan' }, { text: '📊 Топ', callback_data: 'top' }],
    [{ text: '🔔 Подписаться', callback_data: 'subscribe' }, { text: '🔕 Отписаться', callback_data: 'unsubscribe' }],
    [{ text: '📈 Статус', callback_data: 'status' }, { text: '⚙️ Фильтры', callback_data: 'filters' }]
  ]
};

const getFiltersKb = (f) => ({
  inline_keyboard: [
    [{ text: `📉 Мин. спред: ${f.minSpread || 1.5}%`, callback_data: 'noop' }],
    [{ text: `${f.dexEnabled ? '✅' : '❌'} DEX Алерты`, callback_data: 'toggle_dex' }],
    [{ text: '🔙 Назад', callback_data: 'back' }]
  ]
});

function getFilters(chatId) {
  if (!userFilters[chatId]) {
    userFilters[chatId] = { minSpread: 1.5, minVolume: 500000, dexEnabled: true };
  }
  return userFilters[chatId];
}

async function handleMessage(msg) {
  const chatId = msg.chat.id;
  const text = msg.text || '';
  const name = msg.from?.first_name || 'User';
  const f = getFilters(chatId);

  if (text === '/start') {
    userSubscribed[chatId] = true;
    await sendMessage(chatId,
      `👋 <b>Привет, ${name}!</b>\n\n` +
      `Я SpreadUP Bot для арбитража.\n\n` +
      `📊 <b>CEX:</b> MEXC, Gate.io, BingX, HTX\n` +
      `🔗 <b>DEX:</b> Jupiter, Raydium, PancakeSwap и др.\n\n` +
      `✅ Подписка активна!`,
      mainKeyboard
    );
  } else if (text === '/status') {
    await sendMessage(chatId,
      `📊 <b>Статус</b>\n\n` +
      `🔄 Активен\n` +
      `📉 Спред: ${f.minSpread}%\n` +
      `🔗 DEX: ${f.dexEnabled ? '✅' : '❌'}`,
      mainKeyboard
    );
  } else if (text === '/filters') {
    await sendMessage(chatId, '⚙️ <b>Фильтры</b>', getFiltersKb(f));
  } else if (text === '/scan' || text === '/top') {
    await sendMessage(chatId,
      `📊 <b>Топ-5 спредов</b>\n\n` +
      `🥇 BTC: 2.8%\n` +
      `🥈 ETH: 2.3%\n` +
      `🥉 SOL: 1.8%\n` +
      `4. DOGE: 1.6%\n` +
      `5. XRP: 1.5%`,
      mainKeyboard
    );
  } else {
    await sendMessage(chatId, 'Команды: /start, /status, /filters, /help', mainKeyboard);
  }
}

async function handleCallback(cb) {
  const chatId = cb.message?.chat?.id;
  const data = cb.data;
  const f = getFilters(chatId);
  
  await answerCallback(cb.id);

  if (data === 'back') {
    await sendMessage(chatId, '🏠 Меню', mainKeyboard);
  } else if (data === 'subscribe') {
    userSubscribed[chatId] = true;
    await sendMessage(chatId, '✅ Подписка оформлена', mainKeyboard);
  } else if (data === 'unsubscribe') {
    userSubscribed[chatId] = false;
    await sendMessage(chatId, '🔕 Подписка отменена', mainKeyboard);
  } else if (data === 'status') {
    await sendMessage(chatId, `🔗 DEX: ${f.dexEnabled ? '✅' : '❌'}`, mainKeyboard);
  } else if (data === 'filters') {
    await sendMessage(chatId, '⚙️ Фильтры', getFiltersKb(f));
  } else if (data === 'toggle_dex') {
    f.dexEnabled = !f.dexEnabled;
    await sendMessage(chatId, `🔗 DEX ${f.dexEnabled ? 'включён' : 'отключён'}`, getFiltersKb(f));
  } else if (data === 'scan' || data === 'top') {
    await sendMessage(chatId, '📊 BTC: 2.8% | ETH: 2.3% | SOL: 1.8%', mainKeyboard);
  }
}

export default async function handler(req, res) {
  // GET request - status check
  if (req.method === 'GET') {
    return res.status(200).json({
      status: 'SpreadUP Bot Active',
      version: '1.0.0',
      users: Object.keys(userFilters).length
    });
  }

  // POST request - webhook
  try {
    const body = req.body;
    
    if (body.message) {
      await handleMessage(body.message);
    }
    
    if (body.callback_query) {
      await handleCallback(body.callback_query);
    }
    
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error('Error:', e);
    return res.status(200).json({ ok: true, error: e.message });
  }
}
