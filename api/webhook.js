/**
 * SpreadUP Bot - Full Arbitrage Scanner for Vercel Serverless
 * Scans MEXC, Gate.io, BingX, HTX, KuCoin for spot-futures spreads
 */

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8476184475:AAEka7mj2waSrH1XV4z-PWwuMFxwTVVsbHg';
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

// Global cache for prices (persists within same instance)
let priceCache = {
  spot: {},
  futures: {},
  lastUpdate: null,
  opportunities: []
};

// In-memory user storage
const userFilters = {};
const userSubscribed = {};
const lastAlertTime = {}; // Cooldown per asset

// Exchange configurations
const EXCHANGES = {
  mexc: { name: 'MEXC', spotUrl: 'https://www.mexc.com/ru-RU/spot', futuresUrl: 'https://www.mexc.com/ru-RU/futures' },
  gateio: { name: 'Gate.io', spotUrl: 'https://www.gate.io/trade', futuresUrl: 'https://www.gate.io/futures_trade' },
  bingx: { name: 'BingX', spotUrl: 'https://bingx.com/ru-RU/spot', futuresUrl: 'https://bingx.com/ru-RU/futures' },
  htx: { name: 'HTX', spotUrl: 'https://www.htx.com/ru-ru/exchange', futuresUrl: 'https://www.htx.com/ru-ru/futures' },
  kucoin: { name: 'KuCoin', spotUrl: 'https://www.kucoin.com/trade', futuresUrl: 'https://www.kucoin.com/futures' }
};

// ========== Telegram API Functions ==========

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
  const data = { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true };
  if (keyboard) data.reply_markup = keyboard;
  return telegramApi('sendMessage', data);
}

async function answerCallback(callbackId) {
  return telegramApi('answerCallbackQuery', { callback_query_id: callbackId });
}

// ========== Exchange REST API Functions ==========

async function fetchMEXCPrices() {
  try {
    // Spot prices
    const spotRes = await fetch('https://api.mexc.com/api/v3/ticker/24hr');
    const spotData = await spotRes.json();
    
    const spot = {};
    const volumes = {};
    
    for (const item of spotData) {
      const symbol = item.symbol;
      if (symbol.endsWith('USDT')) {
        spot[symbol] = parseFloat(item.lastPrice);
        volumes[symbol] = parseFloat(item.quoteVolume) || 0;
      }
    }
    
    // Futures prices
    const futuresRes = await fetch('https://contract.mexc.com/api/v1/contract/ticker');
    const futuresData = await futuresRes.json();
    
    const futures = {};
    if (futuresData.data) {
      for (const item of futuresData.data) {
        const symbol = item.symbol.replace('_', '');
        futures[symbol] = parseFloat(item.lastPrice);
      }
    }
    
    return { spot, futures, volumes, exchange: 'MEXC' };
  } catch (e) {
    console.error('MEXC error:', e.message);
    return { spot: {}, futures: {}, volumes: {}, exchange: 'MEXC' };
  }
}

async function fetchGateIOPrices() {
  try {
    // Spot prices
    const spotRes = await fetch('https://api.gateio.ws/api/v4/spot/tickers');
    const spotData = await spotRes.json();
    
    const spot = {};
    const volumes = {};
    
    for (const item of spotData) {
      if (item.currency_pair.endsWith('_USDT')) {
        const symbol = item.currency_pair.replace('_', '');
        spot[symbol] = parseFloat(item.last);
        volumes[symbol] = parseFloat(item.quote_volume) || 0;
      }
    }
    
    // Futures prices
    const futuresRes = await fetch('https://api.gateio.ws/api/v4/futures/usdt/contracts');
    const futuresData = await futuresRes.json();
    
    const futures = {};
    for (const item of futuresData) {
      if (item.in_delisting === false) {
        const symbol = item.name.replace('_', '');
        futures[symbol] = parseFloat(item.last_price);
      }
    }
    
    return { spot, futures, volumes, exchange: 'Gate.io' };
  } catch (e) {
    console.error('Gate.io error:', e.message);
    return { spot: {}, futures: {}, volumes: {}, exchange: 'Gate.io' };
  }
}

async function fetchBingXPrices() {
  try {
    // Spot prices
    const spotRes = await fetch('https://open-api.bingx.com/openApi/spot/v1/ticker/24hr');
    const spotData = await spotRes.json();
    
    const spot = {};
    const volumes = {};
    
    if (spotData.data) {
      for (const item of spotData.data) {
        if (item.symbol.endsWith('-USDT')) {
          const symbol = item.symbol.replace('-', '');
          spot[symbol] = parseFloat(item.lastPrice);
          volumes[symbol] = parseFloat(item.quoteVolume) || 0;
        }
      }
    }
    
    // Futures prices
    const futuresRes = await fetch('https://open-api.bingx.com/openApi/swap/v2/quote/contracts');
    const futuresData = await futuresRes.json();
    
    const futures = {};
    if (futuresData.data) {
      for (const item of futuresData.data) {
        if (item.symbol.endsWith('-USDT')) {
          const symbol = item.symbol.replace('-', '');
          futures[symbol] = parseFloat(item.lastPrice);
        }
      }
    }
    
    return { spot, futures, volumes, exchange: 'BingX' };
  } catch (e) {
    console.error('BingX error:', e.message);
    return { spot: {}, futures: {}, volumes: {}, exchange: 'BingX' };
  }
}

async function fetchHTXPrices() {
  try {
    // Spot prices
    const spotRes = await fetch('https://api.huobi.pro/market/tickers');
    const spotData = await spotRes.json();
    
    const spot = {};
    const volumes = {};
    
    if (spotData.data) {
      for (const item of spotData.data) {
        if (item.symbol.endsWith('usdt')) {
          const symbol = item.symbol.toUpperCase().replace('USDT', '') + 'USDT';
          spot[symbol] = parseFloat(item.close);
          volumes[symbol] = parseFloat(item.vol) * parseFloat(item.close) || 0;
        }
      }
    }
    
    // Futures prices - HTX swap
    const futuresRes = await fetch('https://api.huobi.pro/linear-swap-api/v1/swap_contract_info');
    const futuresData = await futuresRes.json();
    
    const futures = {};
    if (futuresData.data) {
      for (const item of futuresData.data) {
        if (item.contract_code.endsWith('-USDT')) {
          const symbol = item.contract_code.replace('-USDT', '') + 'USDT';
          // Need to fetch price separately
        }
      }
    }
    
    // Fetch futures tickers
    try {
      const futTickersRes = await fetch('https://api.huobi.pro/linear-swap-ex/market/tickers');
      const futTickersData = await futTickersRes.json();
      if (futTickersData.data && futTickersData.data.tickers) {
        for (const item of futTickersData.data.tickers) {
          if (item.contract_code.endsWith('-USDT')) {
            const symbol = item.contract_code.replace('-USDT', '') + 'USDT';
            futures[symbol] = parseFloat(item.close);
          }
        }
      }
    } catch (e) {
      console.error('HTX futures tickers error:', e.message);
    }
    
    return { spot, futures, volumes, exchange: 'HTX' };
  } catch (e) {
    console.error('HTX error:', e.message);
    return { spot: {}, futures: {}, volumes: {}, exchange: 'HTX' };
  }
}

async function fetchKuCoinPrices() {
  try {
    // Spot prices
    const spotRes = await fetch('https://api.kucoin.com/api/v1/market/allTickers');
    const spotData = await spotRes.json();
    
    const spot = {};
    const volumes = {};
    
    if (spotData.data && spotData.data.ticker) {
      for (const item of spotData.data.ticker) {
        if (item.symbol.endsWith('-USDT')) {
          const symbol = item.symbol.replace('-', '');
          spot[symbol] = parseFloat(item.last);
          volumes[symbol] = parseFloat(item.volValue) || 0;
        }
      }
    }
    
    // Futures prices
    try {
      const futuresRes = await fetch('https://api-futures.kucoin.com/api/v1/contracts/active');
      const futuresData = await futuresRes.json();
      
      const futuresSymbols = {};
      if (futuresData.data) {
        for (const item of futuresData.data) {
          if (item.quoteCurrency === 'USDT') {
            futuresSymbols[item.symbol] = item.symbolCode;
          }
        }
      }
      
      // Get futures tickers
      const futTickersRes = await fetch('https://api-futures.kucoin.com/api/v1/all-ticker');
      const futTickersData = await futTickersRes.json();
      
      if (futTickersData.data) {
        for (const item of futTickersData.data) {
          const base = item.symbol.replace('USDT', '');
          const symbol = base + 'USDT';
          futures[symbol] = parseFloat(item.last);
        }
      }
    } catch (e) {
      console.error('KuCoin futures error:', e.message);
    }
    
    return { spot, futures, volumes, exchange: 'KuCoin' };
  } catch (e) {
    console.error('KuCoin error:', e.message);
    return { spot: {}, futures: {}, volumes: {}, exchange: 'KuCoin' };
  }
}

// ========== Spread Calculation ==========

async function scanAllExchanges() {
  console.log('Starting full market scan...');
  
  // Fetch all exchanges in parallel
  const [mexc, gateio, bingx, htx, kucoin] = await Promise.all([
    fetchMEXCPrices(),
    fetchGateIOPrices(),
    fetchBingXPrices(),
    fetchHTXPrices(),
    fetchKuCoinPrices()
  ]);
  
  // Combine all data
  const allData = [mexc, gateio, bingx, htx, kucoin];
  
  // Find common symbols across spot and futures
  const opportunities = [];
  
  for (const data of allData) {
    const { spot, futures, volumes, exchange } = data;
    
    for (const symbol in spot) {
      if (futures[symbol]) {
        const spotPrice = spot[symbol];
        const futuresPrice = futures[symbol];
        
        if (spotPrice > 0 && futuresPrice > 0) {
          // Calculate spread: (futures - spot) / spot * 100
          const spread = ((futuresPrice - spotPrice) / spotPrice) * 100;
          
          // Only positive spreads (futures > spot)
          if (spread > 0) {
            const baseAsset = symbol.replace('USDT', '');
            
            opportunities.push({
              symbol,
              baseAsset,
              spotPrice,
              futuresPrice,
              spreadPercent: spread,
              spotExchange: exchange,
              futuresExchange: exchange,
              volume24h: volumes[symbol] || 0,
              spotUrl: getSpotUrl(exchange, symbol),
              futuresUrl: getFuturesUrl(exchange, symbol),
              timestamp: new Date().toISOString()
            });
          }
        }
      }
    }
  }
  
  // Sort by spread descending
  opportunities.sort((a, b) => b.spreadPercent - a.spreadPercent);
  
  // Update cache
  priceCache.opportunities = opportunities;
  priceCache.lastUpdate = new Date();
  
  console.log(`Found ${opportunities.length} opportunities`);
  
  return opportunities;
}

function getSpotUrl(exchange, symbol) {
  const base = symbol.replace('USDT', '');
  switch (exchange) {
    case 'MEXC': return `https://www.mexc.com/exchange/${symbol}`;
    case 'Gate.io': return `https://www.gate.io/trade/${base}_USDT`;
    case 'BingX': return `https://bingx.com/en-us/spot/${base}-USDT`;
    case 'HTX': return `https://www.htx.com/exchange/${base}_USDT`;
    case 'KuCoin': return `https://www.kucoin.com/trade/${base}-USDT`;
    default: return '#';
  }
}

function getFuturesUrl(exchange, symbol) {
  const base = symbol.replace('USDT', '');
  switch (exchange) {
    case 'MEXC': return `https://www.mexc.com/futures/${base}USDT`;
    case 'Gate.io': return `https://www.gate.io/futures_trade/USDT/${base}_USDT`;
    case 'BingX': return `https://bingx.com/en-us/futures/${base}-USDT`;
    case 'HTX': return `https://www.htx.com/futures/linear_swap/${base}_USDT`;
    case 'KuCoin': return `https://www.kucoin.com/futures/trade/${base}USDT`;
    default: return '#';
  }
}

// ========== User Filters ==========

function getFilters(chatId) {
  if (!userFilters[chatId]) {
    userFilters[chatId] = {
      minSpread: 0.5,      // Show spreads from 0.5%
      maxSpread: 100,
      minVolume: 0,        // No volume filter by default
      enabledExchanges: ['MEXC', 'Gate.io', 'BingX', 'HTX', 'KuCoin'],
      dexEnabled: true
    };
  }
  return userFilters[chatId];
}

function filterOpportunities(opportunities, filters) {
  return opportunities.filter(opp => {
    // Spread check
    if (opp.spreadPercent < filters.minSpread || opp.spreadPercent > filters.maxSpread) {
      return false;
    }
    
    // Volume check - only filter if minVolume > 0 AND we have volume data
    if (filters.minVolume > 0 && opp.volume24h > 0 && opp.volume24h < filters.minVolume) {
      return false;
    }
    
    // Exchange check
    if (!filters.enabledExchanges.includes(opp.spotExchange)) {
      return false;
    }
    
    return true;
  });
}

// ========== Alert Sending ==========

async function sendAlerts(opportunities) {
  const subscribers = Object.keys(userSubscribed).filter(id => userSubscribed[id]);
  
  if (subscribers.length === 0) {
    console.log('No subscribers');
    return;
  }
  
  const now = Date.now();
  const cooldownMs = 20 * 60 * 1000; // 20 minutes
  
  for (const opp of opportunities) {
    const assetKey = opp.baseAsset;
    
    // Check cooldown
    if (lastAlertTime[assetKey] && (now - lastAlertTime[assetKey]) < cooldownMs) {
      continue;
    }
    
    // Check minimum spread for alerts
    if (opp.spreadPercent < 2.5) continue;
    
    // Format message
    const spreadEmoji = opp.spreadPercent >= 5 ? '🔥' : opp.spreadPercent >= 3 ? '⚡' : '📊';
    const volStr = opp.volume24h > 0 
      ? (opp.volume24h >= 1000000 ? `$${(opp.volume24h/1000000).toFixed(2)}M` : `$${(opp.volume24h/1000).toFixed(0)}K`)
      : 'н/д';
    
    const message = `
${spreadEmoji} <b>АРБИТРАЖНЫЙ СПРЕД!</b>

📊 <b>Актив:</b> ${opp.baseAsset}/USDT
📈 <b>Спред:</b> ${opp.spreadPercent.toFixed(2)}%

💰 <b>Цены:</b>
   Спот (${opp.spotExchange}): $${formatPrice(opp.spotPrice)}
   Фьючерс (${opp.futuresExchange}): $${formatPrice(opp.futuresPrice)}

📊 <b>Объем 24ч:</b> ${volStr}

🔗 <a href="${opp.spotUrl}">Спот</a> | <a href="${opp.futuresUrl}">Фьючерс</a>
`;
    
    // Send to all subscribers
    for (const chatId of subscribers) {
      const filters = getFilters(chatId);
      
      // Apply user filters
      if (opp.spreadPercent < filters.minSpread) continue;
      if (filters.minVolume > 0 && opp.volume24h > 0 && opp.volume24h < filters.minVolume) continue;
      if (!filters.enabledExchanges.includes(opp.spotExchange)) continue;
      
      try {
        await sendMessage(chatId, message);
      } catch (e) {
        console.error(`Failed to send to ${chatId}:`, e.message);
      }
    }
    
    // Set cooldown
    lastAlertTime[assetKey] = now;
  }
}

function formatPrice(price) {
  if (price >= 1000) return price.toFixed(2);
  if (price >= 1) return price.toFixed(4);
  return price.toFixed(6);
}

// ========== Keyboards ==========

const mainKeyboard = {
  inline_keyboard: [
    [{ text: '🔍 Сканировать', callback_data: 'scan' }, { text: '📊 Топ', callback_data: 'top' }],
    [{ text: '🔔 Подписаться', callback_data: 'subscribe' }, { text: '🔕 Отписаться', callback_data: 'unsubscribe' }],
    [{ text: '📈 Статус', callback_data: 'status' }, { text: '⚙️ Фильтры', callback_data: 'filters' }]
  ]
};

const getFiltersKb = (f) => ({
  inline_keyboard: [
    [{ text: `📉 Мин. спред: ${f.minSpread}%`, callback_data: 'filter_min_spread' }],
    [{ text: `📊 Мин. объём: ${f.minVolume > 0 ? '$' + (f.minVolume/1000).toFixed(0) + 'K' : 'Нет'}`, callback_data: 'filter_min_volume' }],
    [{ text: `${f.dexEnabled ? '✅' : '❌'} DEX Алерты`, callback_data: 'toggle_dex' }],
    [{ text: '💱 Биржи', callback_data: 'filter_exchanges' }],
    [{ text: '🔙 Назад', callback_data: 'back' }]
  ]
});

const getExchangesKb = (enabled) => ({
  inline_keyboard: [
    ...['MEXC', 'Gate.io', 'BingX', 'HTX', 'KuCoin'].map(ex => [{
      text: `${enabled.includes(ex) ? '✅' : '❌'} ${ex}`,
      callback_data: `toggle_exchange_${ex.replace('.', '')}`
    }]),
    [{ text: '✅ Все', callback_data: 'enable_all_exchanges' }, { text: '❌ Ни одной', callback_data: 'disable_all_exchanges' }],
    [{ text: '🔙 Назад', callback_data: 'filters' }]
  ]
});

const getSpreadKb = (type) => ({
  inline_keyboard: [
    [0.5, 1, 1.5, 2, 2.5].map(v => ({
      text: `${v}%`, callback_data: `set_${type}_spread_${v}`
    })),
    [3, 4, 5, 7, 10].map(v => ({
      text: `${v}%`, callback_data: `set_${type}_spread_${v}`
    })),
    [{ text: '🔙 Назад', callback_data: 'filters' }]
  ]
});

const getVolumeKb = () => ({
  inline_keyboard: [
    [100000, 250000, 500000, 750000].map(v => ({
      text: `$${v/1000}K`, callback_data: `set_volume_${v}`
    })),
    [1000000, 2000000, 5000000].map(v => ({
      text: `$${v/1000000}M`, callback_data: `set_volume_${v}`
    })),
    [{ text: '🔙 Назад', callback_data: 'filters' }]
  ]
});

// ========== Message Handlers ==========

async function handleMessage(msg) {
  const chatId = msg.chat.id;
  const text = msg.text || '';
  const name = msg.from?.first_name || 'User';
  const f = getFilters(chatId);

  if (text === '/start') {
    userSubscribed[chatId] = true;
    await sendMessage(chatId,
      `👋 <b>Привет, ${name}!</b>\n\n` +
      `Я SpreadUP Bot для арбитража криптовалют.\n\n` +
      `📊 <b>Биржи:</b> MEXC, Gate.io, BingX, HTX, KuCoin\n\n` +
      `✅ Вы подписаны на уведомления!`,
      mainKeyboard
    );
  } else if (text === '/status') {
    const lastUpdate = priceCache.lastUpdate 
      ? new Date(priceCache.lastUpdate).toLocaleString('ru-RU')
      : 'Нет данных';
    
    await sendMessage(chatId,
      `📊 <b>Статус мониторинга</b>\n\n` +
      `🔄 Состояние: ✅ Активен\n` +
      `⏱ Последнее обновление: ${lastUpdate}\n` +
      `📊 Найдено возможностей: ${priceCache.opportunities.length}\n\n` +
      `⚙️ <b>Ваши фильтры:</b>\n` +
      `📉 Спред: ${f.minSpread}%+\n` +
      `📊 Мин. объём: ${f.minVolume > 0 ? '$' + (f.minVolume/1000).toFixed(0) + 'K' : 'Нет'}\n` +
      `💱 Биржи: ${f.enabledExchanges.join(', ')}`,
      mainKeyboard
    );
  } else if (text === '/filters') {
    await sendMessage(chatId, '⚙️ <b>Фильтры уведомлений</b>', getFiltersKb(f));
  } else if (text === '/scan') {
    await handleScan(chatId);
  } else if (text === '/top') {
    await handleTop(chatId);
  } else if (text === '/help') {
    await sendMessage(chatId,
      `📖 <b>Справка по SpreadUP Bot</b>\n\n` +
      `Команды:\n` +
      `/start - Начать работу\n` +
      `/scan - Сканировать рынок\n` +
      `/top - Топ-10 спредов\n` +
      `/filters - Настроить фильтры\n` +
      `/status - Статус мониторинга\n` +
      `/help - Эта справка`,
      mainKeyboard
    );
  } else {
    await sendMessage(chatId, 'Команды: /start, /scan, /top, /filters, /status, /help', mainKeyboard);
  }
}

async function handleScan(chatId) {
  await sendMessage(chatId, '🔄 <b>Сканирование рынка...</b>');
  
  const opportunities = await scanAllExchanges();
  const f = getFilters(chatId);
  const filtered = filterOpportunities(opportunities, f);
  
  if (filtered.length === 0) {
    await sendMessage(chatId,
      `📊 <b>Результаты сканирования</b>\n\n` +
      `Найдено: ${opportunities.length} возможностей\n` +
      `После фильтрации: 0\n\n` +
      `Попробуйте изменить фильтры.`,
      mainKeyboard
    );
    return;
  }
  
  let text = `📊 <b>Результаты сканирования</b>\n\n`;
  text += `🔍 Фильтры: спред ≥${f.minSpread}%, объём ${f.minVolume > 0 ? '≥$' + (f.minVolume/1000).toFixed(0) + 'K' : 'нет'}\n\n`;
  text += `Найдено: ${opportunities.length} | После фильтрации: ${filtered.length}\n\n`;
  
  for (let i = 0; i < Math.min(10, filtered.length); i++) {
    const opp = filtered[i];
    const emoji = opp.spreadPercent >= 5 ? '🔥' : '⚡';
    const volStr = opp.volume24h > 0 
      ? (opp.volume24h >= 1000000 ? `$${(opp.volume24h/1000000).toFixed(1)}M` : `$${(opp.volume24h/1000).toFixed(0)}K`)
      : 'н/д';
    
    text += `${i+1}. ${emoji} <b>${opp.baseAsset}</b>: ${opp.spreadPercent.toFixed(2)}% (${volStr})\n`;
    text += `   ${opp.spotExchange} → ${opp.futuresExchange}\n\n`;
  }
  
  await sendMessage(chatId, text, mainKeyboard);
}

async function handleTop(chatId) {
  const opportunities = priceCache.opportunities;
  const f = getFilters(chatId);
  const filtered = filterOpportunities(opportunities, f);
  
  if (filtered.length === 0) {
    await sendMessage(chatId,
      `📊 <b>Топ спредов</b>\n\n` +
      `Нет данных. Используйте /scan для сканирования.`,
      mainKeyboard
    );
    return;
  }
  
  let text = `📊 <b>Топ-10 спредов</b>\n\n`;
  
  const medals = ['🥇', '🥈', '🥉'];
  for (let i = 0; i < Math.min(10, filtered.length); i++) {
    const opp = filtered[i];
    const medal = medals[i] || `${i+1}.`;
    const emoji = opp.spreadPercent >= 5 ? '🔥' : '⚡';
    text += `${medal} ${emoji} <b>${opp.baseAsset}</b>: ${opp.spreadPercent.toFixed(2)}%\n`;
  }
  
  await sendMessage(chatId, text, mainKeyboard);
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
    const lastUpdate = priceCache.lastUpdate 
      ? new Date(priceCache.lastUpdate).toLocaleString('ru-RU')
      : 'Нет данных';
    
    await sendMessage(chatId,
      `📊 <b>Статус</b>\n\n` +
      `🔄 Активен\n` +
      `⏱ ${lastUpdate}\n` +
      `📊 Возможностей: ${priceCache.opportunities.length}\n` +
      `🔗 DEX: ${f.dexEnabled ? '✅' : '❌'}`,
      mainKeyboard
    );
  } else if (data === 'filters') {
    await sendMessage(chatId, '⚙️ Фильтры', getFiltersKb(f));
  } else if (data === 'scan') {
    await handleScan(chatId);
  } else if (data === 'top') {
    await handleTop(chatId);
  } else if (data === 'toggle_dex') {
    f.dexEnabled = !f.dexEnabled;
    await sendMessage(chatId, `🔗 DEX ${f.dexEnabled ? 'включён' : 'отключён'}`, getFiltersKb(f));
  } else if (data === 'filter_min_spread') {
    await sendMessage(chatId, '📉 <b>Минимальный спред</b>', getSpreadKb('min'));
  } else if (data === 'filter_min_volume') {
    await sendMessage(chatId, '📊 <b>Минимальный объём</b>', getVolumeKb());
  } else if (data === 'filter_exchanges') {
    await sendMessage(chatId, '💱 <b>Выберите биржи</b>', getExchangesKb(f.enabledExchanges));
  } else if (data.startsWith('set_min_spread_')) {
    const value = parseFloat(data.replace('set_min_spread_', ''));
    f.minSpread = value;
    await sendMessage(chatId, `📉 Мин. спред: ${value}%`, getFiltersKb(f));
  } else if (data.startsWith('set_volume_')) {
    const value = parseFloat(data.replace('set_volume_', ''));
    f.minVolume = value;
    await sendMessage(chatId, `📊 Мин. объём: $${(value/1000).toFixed(0)}K`, getFiltersKb(f));
  } else if (data.startsWith('toggle_exchange_')) {
    const exchange = data.replace('toggle_exchange_', '').replace('Gateio', 'Gate.io');
    const idx = f.enabledExchanges.indexOf(exchange);
    if (idx >= 0) {
      f.enabledExchanges.splice(idx, 1);
    } else {
      f.enabledExchanges.push(exchange);
    }
    await sendMessage(chatId, '💱 Биржи обновлены', getExchangesKb(f.enabledExchanges));
  } else if (data === 'enable_all_exchanges') {
    f.enabledExchanges = ['MEXC', 'Gate.io', 'BingX', 'HTX', 'KuCoin'];
    await sendMessage(chatId, '✅ Все биржи включены', getExchangesKb(f.enabledExchanges));
  } else if (data === 'disable_all_exchanges') {
    f.enabledExchanges = [];
    await sendMessage(chatId, '❌ Все биржи отключены', getExchangesKb(f.enabledExchanges));
  }
}

// ========== Main Handler ==========

export default async function handler(req, res) {
  // GET request - status check or cron
  if (req.method === 'GET') {
    const { cron } = req.query;
    
    if (cron === 'scan') {
      // Cron job - scan and send alerts
      try {
        const opportunities = await scanAllExchanges();
        await sendAlerts(opportunities);
        return res.status(200).json({ 
          status: 'scanned', 
          opportunities: opportunities.length,
          timestamp: new Date().toISOString()
        });
      } catch (e) {
        console.error('Cron scan error:', e);
        return res.status(500).json({ error: e.message });
      }
    }
    
    return res.status(200).json({
      status: 'SpreadUP Bot Active',
      version: '2.0.0',
      opportunities: priceCache.opportunities.length,
      lastUpdate: priceCache.lastUpdate,
      users: Object.keys(userFilters).length,
      subscribers: Object.keys(userSubscribed).filter(id => userSubscribed[id]).length
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
    console.error('Webhook error:', e);
    return res.status(200).json({ ok: true, error: e.message });
  }
}
