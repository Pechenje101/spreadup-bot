/**
 * SpreadUP Bot - Cross-Exchange Arbitrage Scanner
 * Scans MEXC, Gate.io, BingX, Bybit, OKX, Bitget for spot-futures spreads
 * Supports cross-exchange arbitrage (spot on one, futures on another)
 */

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8476184475:AAEka7mj2waSrH1XV4z-PWwuMFxwTVVsbHg';
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

// Global cache for prices
let priceCache = {
  spot: {},      // { "BTCUSDT": { MEXC: 68000, Gate.io: 67950, ... } }
  futures: {},   // { "BTCUSDT": { MEXC: 68100, Gate.io: 68050, ... } }
  volumes: {},   // { "BTCUSDT": { MEXC: 1000000, ... } }
  lastUpdate: null,
  opportunities: []
};

// In-memory user storage
const userFilters = {};
const userSubscribed = {};
const lastAlertTime = {};

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
    const [spotRes, futuresRes] = await Promise.all([
      fetch('https://api.mexc.com/api/v3/ticker/24hr'),
      fetch('https://contract.mexc.com/api/v1/contract/ticker')
    ]);
    
    const spotData = await spotRes.json();
    const futuresData = await futuresRes.json();
    
    const spot = {}, futures = {}, volumes = {};
    
    for (const item of spotData) {
      if (item.symbol.endsWith('USDT')) {
        spot[item.symbol] = parseFloat(item.lastPrice);
        volumes[item.symbol] = parseFloat(item.quoteVolume) || 0;
      }
    }
    
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
    const [spotRes, futuresRes] = await Promise.all([
      fetch('https://api.gateio.ws/api/v4/spot/tickers'),
      fetch('https://api.gateio.ws/api/v4/futures/usdt/contracts')
    ]);
    
    const spotData = await spotRes.json();
    const futuresData = await futuresRes.json();
    
    const spot = {}, futures = {}, volumes = {};
    
    for (const item of spotData) {
      if (item.currency_pair.endsWith('_USDT')) {
        const symbol = item.currency_pair.replace('_', '');
        spot[symbol] = parseFloat(item.last);
        volumes[symbol] = parseFloat(item.quote_volume) || 0;
      }
    }
    
    for (const item of futuresData) {
      if (!item.in_delisting) {
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
    const ts = Date.now();
    const [spotRes, futuresRes] = await Promise.all([
      fetch(`https://open-api.bingx.com/openApi/spot/v1/ticker/24hr?timestamp=${ts}`),
      fetch(`https://open-api.bingx.com/openApi/swap/v2/quote/ticker?timestamp=${ts}`)
    ]);
    
    const spotData = await spotRes.json();
    const futuresData = await futuresRes.json();
    
    const spot = {}, futures = {}, volumes = {};
    
    if (spotData.data) {
      for (const item of spotData.data) {
        if (item.symbol.endsWith('-USDT')) {
          const symbol = item.symbol.replace('-', '');
          spot[symbol] = parseFloat(item.lastPrice);
          volumes[symbol] = parseFloat(item.quoteVolume) || 0;
        }
      }
    }
    
    if (futuresData.data && Array.isArray(futuresData.data)) {
      for (const item of futuresData.data) {
        if (item.symbol && item.symbol.endsWith('-USDT')) {
          const symbol = item.symbol.replace('-', '');
          const price = parseFloat(item.lastPrice);
          if (price > 0) futures[symbol] = price;
        }
      }
    }
    
    return { spot, futures, volumes, exchange: 'BingX' };
  } catch (e) {
    console.error('BingX error:', e.message);
    return { spot: {}, futures: {}, volumes: {}, exchange: 'BingX' };
  }
}

async function fetchBybitPrices() {
  try {
    const [spotRes, futuresRes] = await Promise.all([
      fetch('https://api.bybit.com/v5/market/tickers?category=spot'),
      fetch('https://api.bybit.com/v5/market/tickers?category=linear')
    ]);
    
    const spotData = await spotRes.json();
    const futuresData = await futuresRes.json();
    
    const spot = {}, futures = {}, volumes = {};
    
    if (spotData.result?.list) {
      for (const item of spotData.result.list) {
        if (item.symbol.endsWith('USDT')) {
          spot[item.symbol] = parseFloat(item.lastPrice);
          volumes[item.symbol] = parseFloat(item.turnover24h) || 0;
        }
      }
    }
    
    if (futuresData.result?.list) {
      for (const item of futuresData.result.list) {
        if (item.symbol.endsWith('USDT') && !item.symbol.includes('1000000')) {
          futures[item.symbol] = parseFloat(item.lastPrice);
        }
      }
    }
    
    return { spot, futures, volumes, exchange: 'Bybit' };
  } catch (e) {
    console.error('Bybit error:', e.message);
    return { spot: {}, futures: {}, volumes: {}, exchange: 'Bybit' };
  }
}

async function fetchOKXPrices() {
  try {
    const [spotRes, futuresRes] = await Promise.all([
      fetch('https://www.okx.com/api/v5/market/tickers?instType=SPOT'),
      fetch('https://www.okx.com/api/v5/market/tickers?instType=SWAP')
    ]);
    
    const spotData = await spotRes.json();
    const futuresData = await futuresRes.json();
    
    const spot = {}, futures = {}, volumes = {};
    
    if (spotData.data) {
      for (const item of spotData.data) {
        if (item.instId.endsWith('-USDT')) {
          const symbol = item.instId.replace('-', '');
          spot[symbol] = parseFloat(item.last);
          volumes[symbol] = parseFloat(item.vol24h) * parseFloat(item.last) || 0;
        }
      }
    }
    
    if (futuresData.data) {
      for (const item of futuresData.data) {
        if (item.instId.endsWith('-USDT-SWAP')) {
          const symbol = item.instId.replace('-USDT-SWAP', '') + 'USDT';
          futures[symbol] = parseFloat(item.last);
        }
      }
    }
    
    return { spot, futures, volumes, exchange: 'OKX' };
  } catch (e) {
    console.error('OKX error:', e.message);
    return { spot: {}, futures: {}, volumes: {}, exchange: 'OKX' };
  }
}

async function fetchBitgetPrices() {
  try {
    const [spotRes, futuresRes] = await Promise.all([
      fetch('https://api.bitget.com/api/v2/spot/market/tickers'),
      fetch('https://api.bitget.com/api/v2/mix/market/tickers?productType=USDT-FUTURES')
    ]);
    
    const spotData = await spotRes.json();
    const futuresData = await futuresRes.json();
    
    const spot = {}, futures = {}, volumes = {};
    
    if (spotData.data) {
      for (const item of spotData.data) {
        if (item.symbol.endsWith('USDT')) {
          spot[item.symbol] = parseFloat(item.lastPr);
          volumes[item.symbol] = parseFloat(item.baseVolume) * parseFloat(item.lastPr) || 0;
        }
      }
    }
    
    if (futuresData.data) {
      for (const item of futuresData.data) {
        if (item.symbol.endsWith('USDT')) {
          futures[item.symbol] = parseFloat(item.lastPr);
        }
      }
    }
    
    return { spot, futures, volumes, exchange: 'Bitget' };
  } catch (e) {
    console.error('Bitget error:', e.message);
    return { spot: {}, futures: {}, volumes: {}, exchange: 'Bitget' };
  }
}

// ========== Price Aggregation ==========

async function scanAllExchanges() {
  console.log('Starting cross-exchange market scan...');
  
  // Fetch all exchanges in parallel
  const results = await Promise.all([
    fetchMEXCPrices(),
    fetchGateIOPrices(),
    fetchBingXPrices(),
    fetchBybitPrices(),
    fetchOKXPrices(),
    fetchBitgetPrices()
  ]);
  
  // Aggregate prices by symbol
  const allSpot = {};      // { "BTCUSDT": { MEXC: 68000, Gate.io: 67950, ... } }
  const allFutures = {};   // { "BTCUSDT": { MEXC: 68100, Gate.io: 68050, ... } }
  const allVolumes = {};   // { "BTCUSDT": 1000000 }
  
  const exchangeStats = {};
  
  for (const { spot, futures, volumes, exchange } of results) {
    exchangeStats[exchange] = {
      spot: Object.keys(spot).length,
      futures: Object.keys(futures).length
    };
    
    // Aggregate spot
    for (const symbol in spot) {
      if (!allSpot[symbol]) allSpot[symbol] = {};
      allSpot[symbol][exchange] = spot[symbol];
      allVolumes[symbol] = Math.max(allVolumes[symbol] || 0, volumes[symbol] || 0);
    }
    
    // Aggregate futures
    for (const symbol in futures) {
      if (!allFutures[symbol]) allFutures[symbol] = {};
      allFutures[symbol][exchange] = futures[symbol];
    }
  }
  
  // Find cross-exchange opportunities
  const opportunities = [];
  const exchanges = ['MEXC', 'Gate.io', 'BingX', 'Bybit', 'OKX', 'Bitget'];
  
  for (const symbol in allSpot) {
    const spotPrices = allSpot[symbol];
    const futuresPrices = allFutures[symbol];
    
    if (!futuresPrices) continue;
    
    // Find best spot (lowest) and best futures (highest)
    let bestSpot = null, bestSpotPrice = Infinity;
    let bestFutures = null, bestFuturesPrice = 0;
    
    for (const ex of exchanges) {
      if (spotPrices[ex] && spotPrices[ex] > 0 && spotPrices[ex] < bestSpotPrice) {
        bestSpotPrice = spotPrices[ex];
        bestSpot = ex;
      }
      if (futuresPrices[ex] && futuresPrices[ex] > bestFuturesPrice) {
        bestFuturesPrice = futuresPrices[ex];
        bestFutures = ex;
      }
    }
    
    if (!bestSpot || !bestFutures || bestSpotPrice <= 0 || bestFuturesPrice <= 0) continue;
    
    // Calculate spread
    const spread = ((bestFuturesPrice - bestSpotPrice) / bestSpotPrice) * 100;
    
    if (spread > 0) {
      const baseAsset = symbol.replace('USDT', '');
      opportunities.push({
        symbol,
        baseAsset,
        spotPrice: bestSpotPrice,
        futuresPrice: bestFuturesPrice,
        spreadPercent: spread,
        spotExchange: bestSpot,
        futuresExchange: bestFutures,
        isCrossExchange: bestSpot !== bestFutures,
        volume24h: allVolumes[symbol] || 0,
        spotUrl: getUrl(bestSpot, symbol, 'spot'),
        futuresUrl: getUrl(bestFutures, symbol, 'futures'),
        timestamp: new Date().toISOString()
      });
    }
  }
  
  // Sort by spread descending
  opportunities.sort((a, b) => b.spreadPercent - a.spreadPercent);
  
  // Update cache
  priceCache.spot = allSpot;
  priceCache.futures = allFutures;
  priceCache.volumes = allVolumes;
  priceCache.opportunities = opportunities;
  priceCache.lastUpdate = new Date();
  
  console.log(`Found ${opportunities.length} opportunities. Exchanges:`, exchangeStats);
  
  return opportunities;
}

function getUrl(exchange, symbol, type) {
  const base = symbol.replace('USDT', '');
  const isSpot = type === 'spot';
  
  const urls = {
    'MEXC': isSpot 
      ? `https://www.mexc.com/exchange/${symbol}`
      : `https://www.mexc.com/futures/${base}USDT`,
    'Gate.io': isSpot
      ? `https://www.gate.io/trade/${base}_USDT`
      : `https://www.gate.io/futures_trade/USDT/${base}_USDT`,
    'BingX': isSpot
      ? `https://bingx.com/en-us/spot/${base}-USDT`
      : `https://bingx.com/en-us/futures/${base}-USDT`,
    'Bybit': isSpot
      ? `https://www.bybit.com/trade/spot/${symbol}`
      : `https://www.bybit.com/trade/usdt/${symbol}`,
    'OKX': isSpot
      ? `https://www.okx.com/trade-spot/${base}-USDT`
      : `https://www.okx.com/trade-swap/${base}-USDT-SWAP`,
    'Bitget': isSpot
      ? `https://www.bitget.com/spot/${symbol}`
      : `https://www.bitget.com/futures/usdt/${symbol}`
  };
  
  return urls[exchange] || '#';
}

// ========== User Filters ==========

function getFilters(chatId) {
  if (!userFilters[chatId]) {
    userFilters[chatId] = {
      minSpread: 0.5,
      maxSpread: 100,
      minVolume: 0,
      enabledExchanges: ['MEXC', 'Gate.io', 'BingX', 'Bybit', 'OKX', 'Bitget'],
      showCrossExchange: true
    };
  }
  return userFilters[chatId];
}

function filterOpportunities(opportunities, filters) {
  return opportunities.filter(opp => {
    if (opp.spreadPercent < filters.minSpread || opp.spreadPercent > filters.maxSpread) return false;
    if (filters.minVolume > 0 && opp.volume24h > 0 && opp.volume24h < filters.minVolume) return false;
    if (!filters.enabledExchanges.includes(opp.spotExchange)) return false;
    if (!filters.enabledExchanges.includes(opp.futuresExchange)) return false;
    return true;
  });
}

// ========== Alert Sending ==========

async function sendAlerts(opportunities) {
  const subscribers = Object.keys(userSubscribed).filter(id => userSubscribed[id]);
  if (subscribers.length === 0) return;
  
  const now = Date.now();
  const cooldownMs = 20 * 60 * 1000;
  
  for (const opp of opportunities) {
    const assetKey = opp.baseAsset;
    if (lastAlertTime[assetKey] && (now - lastAlertTime[assetKey]) < cooldownMs) continue;
    if (opp.spreadPercent < 2.5) continue;
    
    const spreadEmoji = opp.spreadPercent >= 5 ? '🔥' : opp.spreadPercent >= 3 ? '⚡' : '📊';
    const crossEmoji = opp.isCrossExchange ? '🔗 ' : '';
    const volStr = opp.volume24h > 0 
      ? (opp.volume24h >= 1000000 ? `$${(opp.volume24h/1000000).toFixed(1)}M` : `$${(opp.volume24h/1000).toFixed(0)}K`)
      : 'н/д';
    
    const message = `
${spreadEmoji} <b>АРБИТРАЖНЫЙ СПРЕД!</b>

${crossEmoji}📊 <b>Актив:</b> ${opp.baseAsset}/USDT
📈 <b>Спред:</b> ${opp.spreadPercent.toFixed(2)}%

💰 <b>Цены:</b>
   Спот (${opp.spotExchange}): $${formatPrice(opp.spotPrice)}
   Фьючерс (${opp.futuresExchange}): $${formatPrice(opp.futuresPrice)}

📊 <b>Объем 24ч:</b> ${volStr}
${opp.isCrossExchange ? '\n⚠️ <b>Межбиржевой арбитраж!</b>\n' : ''}
🔗 <a href="${opp.spotUrl}">Спот</a> | <a href="${opp.futuresUrl}">Фьючерс</a>
`;
    
    for (const chatId of subscribers) {
      const filters = getFilters(chatId);
      if (opp.spreadPercent < filters.minSpread) continue;
      if (!filters.enabledExchanges.includes(opp.spotExchange)) continue;
      if (!filters.enabledExchanges.includes(opp.futuresExchange)) continue;
      
      try {
        await sendMessage(chatId, message);
      } catch (e) {
        console.error(`Failed to send to ${chatId}:`, e.message);
      }
    }
    
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
    [{ text: `${f.showCrossExchange ? '✅' : '❌'} Межбиржевые`, callback_data: 'toggle_cross' }],
    [{ text: '💱 Биржи', callback_data: 'filter_exchanges' }],
    [{ text: '🔙 Назад', callback_data: 'back' }]
  ]
});

const getExchangesKb = (enabled) => ({
  inline_keyboard: [
    ...['MEXC', 'Gate.io', 'BingX', 'Bybit', 'OKX', 'Bitget'].map(ex => [{
      text: `${enabled.includes(ex) ? '✅' : '❌'} ${ex}`,
      callback_data: `toggle_exchange_${ex.replace('.', '')}`
    }]),
    [{ text: '✅ Все', callback_data: 'enable_all' }, { text: '❌ Сброс', callback_data: 'disable_all' }],
    [{ text: '🔙 Назад', callback_data: 'filters' }]
  ]
});

const getSpreadKb = (type) => ({
  inline_keyboard: [
    [0.5, 1, 1.5, 2, 2.5].map(v => ({ text: `${v}%`, callback_data: `set_${type}_spread_${v}` })),
    [3, 4, 5, 7, 10].map(v => ({ text: `${v}%`, callback_data: `set_${type}_spread_${v}` })),
    [{ text: '🔙 Назад', callback_data: 'filters' }]
  ]
});

const getVolumeKb = () => ({
  inline_keyboard: [
    [0, 100000, 250000, 500000].map(v => ({
      text: v === 0 ? 'Нет' : `$${v/1000}K`, callback_data: `set_volume_${v}`
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
      `📊 <b>Биржи:</b> MEXC, Gate.io, BingX, Bybit, OKX, Bitget\n\n` +
      `🔗 <b>Межбиржевой арбитраж:</b> spot на одной бирже, futures на другой!\n\n` +
      `✅ Вы подписаны на уведомления!`,
      mainKeyboard
    );
  } else if (text === '/status') {
    const lastUpdate = priceCache.lastUpdate 
      ? new Date(priceCache.lastUpdate).toLocaleString('ru-RU')
      : 'Нет данных';
    
    const crossCount = priceCache.opportunities.filter(o => o.isCrossExchange).length;
    
    await sendMessage(chatId,
      `📊 <b>Статус мониторинга</b>\n\n` +
      `🔄 Состояние: ✅ Активен\n` +
      `⏱ Последнее обновление: ${lastUpdate}\n` +
      `📊 Найдено возможностей: ${priceCache.opportunities.length}\n` +
      `🔗 Межбиржевых: ${crossCount}\n\n` +
      `⚙️ <b>Ваши фильтры:</b>\n` +
      `📉 Спред: ${f.minSpread}%+\n` +
      `📊 Мин. объём: ${f.minVolume > 0 ? '$' + (f.minVolume/1000).toFixed(0) + 'K' : 'нет'}\n` +
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
      `<b>Команды:</b>\n` +
      `/start - Начать работу\n` +
      `/scan - Сканировать рынок\n` +
      `/top - Топ-10 спредов\n` +
      `/filters - Настроить фильтры\n` +
      `/status - Статус\n\n` +
      `<b>Биржи:</b> MEXC, Gate.io, BingX, Bybit, OKX, Bitget\n\n` +
      `🔗 <b>Межбиржевой арбитраж</b> - находит лучшие связки между разными биржами!`,
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
  
  const crossCount = filtered.filter(o => o.isCrossExchange).length;
  
  let text = `📊 <b>Результаты сканирования</b>\n\n`;
  text += `🔍 Фильтры: спред ≥${f.minSpread}%, объём ${f.minVolume > 0 ? '≥$' + (f.minVolume/1000).toFixed(0) + 'K' : 'нет'}\n\n`;
  text += `Найдено: ${opportunities.length} | После фильтрации: ${filtered.length}\n`;
  text += `🔗 Межбиржевых: ${crossCount}\n\n`;
  
  for (let i = 0; i < Math.min(10, filtered.length); i++) {
    const opp = filtered[i];
    const emoji = opp.spreadPercent >= 5 ? '🔥' : '⚡';
    const crossEmoji = opp.isCrossExchange ? '🔗 ' : '';
    const volStr = opp.volume24h > 0 
      ? (opp.volume24h >= 1000000 ? `$${(opp.volume24h/1000000).toFixed(1)}M` : `$${(opp.volume24h/1000).toFixed(0)}K`)
      : 'н/д';
    
    text += `${i+1}. ${emoji} <b>${opp.baseAsset}</b>: ${opp.spreadPercent.toFixed(2)}% (${volStr})\n`;
    text += `   ${crossEmoji}${opp.spotExchange} → ${opp.futuresExchange}\n\n`;
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
    const crossEmoji = opp.isCrossExchange ? '🔗' : '';
    text += `${medal} ${emoji} ${crossEmoji} <b>${opp.baseAsset}</b>: ${opp.spreadPercent.toFixed(2)}%\n`;
    text += `    ${opp.spotExchange} → ${opp.futuresExchange}\n`;
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
    await handleStatus(chatId);
  } else if (data === 'filters') {
    await sendMessage(chatId, '⚙️ Фильтры', getFiltersKb(f));
  } else if (data === 'scan') {
    await handleScan(chatId);
  } else if (data === 'top') {
    await handleTop(chatId);
  } else if (data === 'toggle_cross') {
    f.showCrossExchange = !f.showCrossExchange;
    await sendMessage(chatId, `🔗 Межбиржевые: ${f.showCrossExchange ? 'включены' : 'отключены'}`, getFiltersKb(f));
  } else if (data === 'filter_min_spread') {
    await sendMessage(chatId, '📉 <b>Минимальный спред</b>', getSpreadKb('min'));
  } else if (data === 'filter_min_volume') {
    await sendMessage(chatId, '📊 <b>Минимальный объём</b>', getVolumeKb());
  } else if (data === 'filter_exchanges') {
    await sendMessage(chatId, '💱 <b>Выберите биржи</b>', getExchangesKb(f.enabledExchanges));
  } else if (data.startsWith('set_min_spread_')) {
    f.minSpread = parseFloat(data.replace('set_min_spread_', ''));
    await sendMessage(chatId, `📉 Мин. спред: ${f.minSpread}%`, getFiltersKb(f));
  } else if (data.startsWith('set_volume_')) {
    f.minVolume = parseFloat(data.replace('set_volume_', ''));
    await sendMessage(chatId, `📊 Мин. объём: ${f.minVolume > 0 ? '$' + (f.minVolume/1000).toFixed(0) + 'K' : 'нет'}`, getFiltersKb(f));
  } else if (data.startsWith('toggle_exchange_')) {
    const exchange = data.replace('toggle_exchange_', '').replace('Gateio', 'Gate.io');
    const idx = f.enabledExchanges.indexOf(exchange);
    if (idx >= 0) f.enabledExchanges.splice(idx, 1);
    else f.enabledExchanges.push(exchange);
    await sendMessage(chatId, '💱 Биржи обновлены', getExchangesKb(f.enabledExchanges));
  } else if (data === 'enable_all') {
    f.enabledExchanges = ['MEXC', 'Gate.io', 'BingX', 'Bybit', 'OKX', 'Bitget'];
    await sendMessage(chatId, '✅ Все биржи включены', getExchangesKb(f.enabledExchanges));
  } else if (data === 'disable_all') {
    f.enabledExchanges = [];
    await sendMessage(chatId, '❌ Все биржи отключены', getExchangesKb(f.enabledExchanges));
  }
}

async function handleStatus(chatId) {
  const lastUpdate = priceCache.lastUpdate 
    ? new Date(priceCache.lastUpdate).toLocaleString('ru-RU')
    : 'Нет данных';
  const f = getFilters(chatId);
  const crossCount = priceCache.opportunities.filter(o => o.isCrossExchange).length;
  
  await sendMessage(chatId,
    `📊 <b>Статус</b>\n\n` +
    `🔄 Активен\n` +
    `⏱ ${lastUpdate}\n` +
    `📊 Возможностей: ${priceCache.opportunities.length}\n` +
    `🔗 Межбиржевых: ${crossCount}\n` +
    `💱 Биржи: ${f.enabledExchanges.length}/6`,
    mainKeyboard
  );
}

// ========== Main Handler ==========

export default async function handler(req, res) {
  if (req.method === 'GET') {
    const { cron } = req.query;
    
    if (cron === 'scan') {
      try {
        const opportunities = await scanAllExchanges();
        await sendAlerts(opportunities);
        return res.status(200).json({ 
          status: 'scanned', 
          opportunities: opportunities.length,
          crossExchange: opportunities.filter(o => o.isCrossExchange).length,
          timestamp: new Date().toISOString()
        });
      } catch (e) {
        console.error('Cron scan error:', e);
        return res.status(500).json({ error: e.message });
      }
    }
    
    return res.status(200).json({
      status: 'SpreadUP Bot Active',
      version: '3.0.0',
      features: ['cross-exchange', '6-exchanges'],
      exchanges: ['MEXC', 'Gate.io', 'BingX', 'Bybit', 'OKX', 'Bitget'],
      opportunities: priceCache.opportunities.length,
      lastUpdate: priceCache.lastUpdate,
      users: Object.keys(userFilters).length
    });
  }

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
