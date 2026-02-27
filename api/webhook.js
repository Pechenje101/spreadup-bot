/**
 * SpreadUP Bot v5.1 - Enhanced Arbitrage Scanner
 * 
 * Features:
 * - Spot-Futures Arbitrage (cross-exchange)
 * - Funding Rate Arbitrage
 * - Jupiter (Solana DEX) Integration
 * - HTX (Huobi) Integration
 * - Price Alerts
 * - Spread History
 * 
 * Exchanges: MEXC, Gate.io, BingX, Bybit, OKX, Bitget, HTX, Jupiter
 */

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8476184475:AAEka7mj2waSrH1XV4z-PWwuMFxwTVVsbHg';
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

// Global cache
let priceCache = {
  spot: {},
  futures: {},
  volumes: {},
  fundingRates: {},
  lastUpdate: null,
  opportunities: [],
  fundingOpps: [],
  spreadHistory: {},
  exchangeStats: {}
};

// User storage
const userFilters = {};
const userSubscribed = {};
const lastAlertTime = {};

// All supported exchanges
const ALL_EXCHANGES = ['MEXC', 'Gate.io', 'BingX', 'Bybit', 'OKX', 'Bitget', 'HTX', 'Jupiter'];

// ========== Telegram API ==========

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

// ========== Exchange Fetchers ==========

async function fetchMEXCPrices() {
  try {
    const [spotRes, futuresRes, fundingRes] = await Promise.all([
      fetch('https://api.mexc.com/api/v3/ticker/24hr'),
      fetch('https://contract.mexc.com/api/v1/contract/ticker'),
      fetch('https://contract.mexc.com/api/v1/contract/funding_rate')
    ]);
    
    const spotData = await spotRes.json();
    const futuresData = await futuresRes.json();
    const fundingData = await fundingRes.json();
    
    const spot = {}, futures = {}, volumes = {}, funding = {};
    
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
    
    if (fundingData.data) {
      for (const item of fundingData.data) {
        const symbol = item.symbol.replace('_', '');
        funding[symbol] = parseFloat(item.fundingRate) || 0;
      }
    }
    
    return { spot, futures, volumes, funding, exchange: 'MEXC' };
  } catch (e) {
    console.error('MEXC error:', e.message);
    return { spot: {}, futures: {}, volumes: {}, funding: {}, exchange: 'MEXC' };
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
    
    const spot = {}, futures = {}, volumes = {}, funding = {};
    
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
        funding[symbol] = parseFloat(item.funding_rate) || 0;
      }
    }
    
    return { spot, futures, volumes, funding, exchange: 'Gate.io' };
  } catch (e) {
    console.error('Gate.io error:', e.message);
    return { spot: {}, futures: {}, volumes: {}, funding: {}, exchange: 'Gate.io' };
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
    
    const spot = {}, futures = {}, volumes = {}, funding = {};
    
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
          if (price > 0) {
            futures[symbol] = price;
            funding[symbol] = parseFloat(item.fundingRate) || 0;
          }
        }
      }
    }
    
    return { spot, futures, volumes, funding, exchange: 'BingX' };
  } catch (e) {
    console.error('BingX error:', e.message);
    return { spot: {}, futures: {}, volumes: {}, funding: {}, exchange: 'BingX' };
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
    
    const spot = {}, futures = {}, volumes = {}, funding = {};
    
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
          funding[item.symbol] = parseFloat(item.fundingRate) || 0;
        }
      }
    }
    
    return { spot, futures, volumes, funding, exchange: 'Bybit' };
  } catch (e) {
    console.error('Bybit error:', e.message);
    return { spot: {}, futures: {}, volumes: {}, funding: {}, exchange: 'Bybit' };
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
    
    const spot = {}, futures = {}, volumes = {}, funding = {};
    
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
          funding[symbol] = parseFloat(item.fundingRate) || 0;
        }
      }
    }
    
    return { spot, futures, volumes, funding, exchange: 'OKX' };
  } catch (e) {
    console.error('OKX error:', e.message);
    return { spot: {}, futures: {}, volumes: {}, funding: {}, exchange: 'OKX' };
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
    
    const spot = {}, futures = {}, volumes = {}, funding = {};
    
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
          funding[item.symbol] = parseFloat(item.fundingRate) || 0;
        }
      }
    }
    
    return { spot, futures, volumes, funding, exchange: 'Bitget' };
  } catch (e) {
    console.error('Bitget error:', e.message);
    return { spot: {}, futures: {}, volumes: {}, funding: {}, exchange: 'Bitget' };
  }
}

// HTX (Huobi) - Only spot, futures API not publicly available
async function fetchHTXPrices() {
  try {
    const spot = {}, volumes = {};
    
    // Popular trading pairs to fetch
    const symbols = [
      'btcusdt', 'ethusdt', 'solusdt', 'bnbusdt', 'xrpusdt', 'adausdt', 'dogeusdt',
      'avaxusdt', 'dotusdt', 'maticusdt', 'linkusdt', 'uniusdt', 'atomusdt', 'ltcusdt',
      'etcusdt', 'nearusdt', 'aaveusdt', 'filusdt', 'arbusdt', 'opusdt', 'aptusdt',
      'suiusdt', 'seiusdt', 'wldusdt', 'pepeusdt', 'flokiusdt', 'injusdt', 'samusdt',
      'shibusdt', 'bonkusdt', 'jupusdt', 'wifusdt', 'popcatusdt', 'neirusdt', 'taousdt'
    ];
    
    // Fetch prices in parallel with Promise.all
    const fetchPromises = symbols.map(async (sym) => {
      try {
        const res = await fetch(`https://api.htx.com/market/detail/merged?symbol=${sym}`, {
          signal: AbortSignal.timeout(10000)
        });
        const data = await res.json();
        
        if (data.status === 'ok' && data.tick) {
          const symbol = sym.toUpperCase().replace('USDT', '') + 'USDT';
          const price = parseFloat(data.tick.close);
          const vol = parseFloat(data.tick.vol) || 0;
          
          if (price > 0) {
            return { symbol, price, vol };
          }
        }
      } catch (e) {
        // Continue if one request fails
      }
      return null;
    });
    
    const results = await Promise.all(fetchPromises);
    
    for (const result of results) {
      if (result) {
        spot[result.symbol] = result.price;
        volumes[result.symbol] = result.vol;
      }
    }
    
    console.log(`HTX: ${Object.keys(spot).length} spot prices`);
    return { spot, futures: {}, volumes, funding: {}, exchange: 'HTX' };
  } catch (e) {
    console.error('HTX error:', e.message);
    return { spot: {}, futures: {}, volumes: {}, funding: {}, exchange: 'HTX' };
  }
}

// Jupiter (Solana DEX via Dexscreener)
async function fetchJupiterPrices() {
  try {
    const spot = {}, volumes = {};
    
    const popularTokens = [
      { symbol: 'SOL', address: 'So11111111111111111111111111111111111111112' },
      { symbol: 'BONK', address: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263' },
      { symbol: 'WIF', address: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm' },
      { symbol: 'JUP', address: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN' },
      { symbol: 'PYTH', address: 'H6ARHf6YXhGYeQfUzQNGk6rDNnLvQHod4ekB3GgqPAiV' },
      { symbol: 'RAY', address: '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R' },
      { symbol: 'ORCA', address: 'orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE' },
      { symbol: 'RENDER', address: 'rndrizKT3MK1iimdxRmWzYBfFW6E3kVvkdZ1uWgjThq' },
      { symbol: 'JITO', address: 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn' },
      { symbol: 'BOME', address: 'UKMMBLkZqCrwKBJcHUY1GJSBVGSjimXePVvb5HjTRSt' },
      { symbol: 'POPCAT', address: '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr' },
      { symbol: 'MYRO', address: 'HhJpBhRRn4g56VsyLuT8DL5Bv31HkXqsrahEHhMjob6J' },
      { symbol: 'MEW', address: 'MEW1gQWJ3nEXg2qgERiKu7FAFj79PHvQVREQUzScPP5' },
      { symbol: 'NEIRO', address: '8Ki8DpuWNxu9VsYzKvnv6hP9nB5XK9QPC8eSNyZYPQvy' }
    ];
    
    const fetchPromises = popularTokens.map(async (token) => {
      try {
        const tokenRes = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${token.address}`);
        const tokenData = await tokenRes.json();
        
        if (tokenData.pairs && tokenData.pairs.length > 0) {
          const bestPair = tokenData.pairs
            .filter(p => 
              p.chainId === 'solana' && 
              (p.quoteToken?.symbol === 'USDC' || p.quoteToken?.symbol === 'USDT') &&
              p.liquidity?.usd > 10000
            )
            .sort((a, b) => (parseFloat(b.liquidity?.usd || 0)) - (parseFloat(a.liquidity?.usd || 0)))[0];
          
          if (bestPair && bestPair.priceUsd) {
            const symbol = token.symbol.toUpperCase() + 'USDT';
            const price = parseFloat(bestPair.priceUsd);
            if (price > 0) {
              return {
                symbol,
                price,
                volume: parseFloat(bestPair.volume?.h24 || 0)
              };
            }
          }
        }
      } catch (e) {}
      return null;
    });
    
    const results = await Promise.all(fetchPromises);
    
    for (const result of results) {
      if (result) {
        spot[result.symbol] = result.price;
        volumes[result.symbol] = result.volume;
      }
    }
    
    console.log(`Jupiter: ${Object.keys(spot).length} DEX prices`);
    return { spot, futures: {}, volumes, funding: {}, exchange: 'Jupiter' };
  } catch (e) {
    console.error('Jupiter error:', e.message);
    return { spot: {}, futures: {}, volumes: {}, funding: {}, exchange: 'Jupiter' };
  }
}

// ========== Scanning ==========

async function scanAllExchanges() {
  console.log('Starting full market scan...');
  
  const results = await Promise.all([
    fetchMEXCPrices(),
    fetchGateIOPrices(),
    fetchBingXPrices(),
    fetchBybitPrices(),
    fetchOKXPrices(),
    fetchBitgetPrices(),
    fetchHTXPrices(),
    fetchJupiterPrices()
  ]);
  
  const allSpot = {}, allFutures = {}, allVolumes = {}, allFunding = {};
  const exchangeStats = {};
  
  for (const { spot, futures, volumes, funding, exchange } of results) {
    exchangeStats[exchange] = {
      spot: Object.keys(spot).length,
      futures: Object.keys(futures).length
    };
    
    for (const symbol in spot) {
      if (!allSpot[symbol]) allSpot[symbol] = {};
      allSpot[symbol][exchange] = spot[symbol];
      allVolumes[symbol] = Math.max(allVolumes[symbol] || 0, volumes[symbol] || 0);
    }
    
    for (const symbol in futures) {
      if (!allFutures[symbol]) allFutures[symbol] = {};
      allFutures[symbol][exchange] = futures[symbol];
      
      if (!allFunding[symbol]) allFunding[symbol] = {};
      allFunding[symbol][exchange] = funding[symbol] || 0;
    }
  }
  
  // === Spot-Futures Opportunities ===
  const spotFuturesOpps = [];
  
  for (const symbol in allSpot) {
    const spotPrices = allSpot[symbol];
    const futuresPrices = allFutures[symbol];
    if (!futuresPrices) continue;
    
    let bestSpot = null, bestSpotPrice = Infinity;
    let bestFutures = null, bestFuturesPrice = 0;
    
    for (const ex of ALL_EXCHANGES) {
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
    
    const spread = ((bestFuturesPrice - bestSpotPrice) / bestSpotPrice) * 100;
    
    if (spread > 0) {
      spotFuturesOpps.push({
        type: 'spot-futures',
        symbol,
        baseAsset: symbol.replace('USDT', ''),
        spotPrice: bestSpotPrice,
        futuresPrice: bestFuturesPrice,
        spreadPercent: spread,
        spotExchange: bestSpot,
        futuresExchange: bestFutures,
        isCrossExchange: bestSpot !== bestFutures,
        isDexInvolved: bestSpot === 'Jupiter' || bestFutures === 'Jupiter',
        volume24h: allVolumes[symbol] || 0,
        spotUrl: getUrl(bestSpot, symbol, 'spot'),
        futuresUrl: getUrl(bestFutures, symbol, 'futures'),
        allSpotPrices: spotPrices,
        allFuturesPrices: futuresPrices
      });
    }
  }
  
  spotFuturesOpps.sort((a, b) => b.spreadPercent - a.spreadPercent);
  
  // === Funding Rate Opportunities ===
  const fundingOpps = [];
  
  for (const symbol in allFunding) {
    const rates = allFunding[symbol];
    const futuresPrices = allFutures[symbol];
    if (!futuresPrices) continue;
    
    let maxRate = -Infinity, maxEx = null;
    let minRate = Infinity, minEx = null;
    
    for (const ex of ALL_EXCHANGES) {
      if (rates[ex] !== undefined && futuresPrices[ex]) {
        if (rates[ex] > maxRate) {
          maxRate = rates[ex];
          maxEx = ex;
        }
        if (rates[ex] < minRate) {
          minRate = rates[ex];
          minEx = ex;
        }
      }
    }
    
    if (maxEx && minEx && maxRate > minRate) {
      const rateDiff = maxRate - minRate;
      const dailyProfitPercent = rateDiff * 3 * 100;
      
      if (dailyProfitPercent > 0.01) {
        fundingOpps.push({
          type: 'funding-rate',
          symbol,
          baseAsset: symbol.replace('USDT', ''),
          longExchange: minEx,
          shortExchange: maxEx,
          longRate: minRate,
          shortRate: maxRate,
          rateDiff,
          dailyProfitPercent,
          price: futuresPrices[maxEx] || futuresPrices[minEx] || 0,
          volume24h: allVolumes[symbol] || 0
        });
      }
    }
  }
  
  fundingOpps.sort((a, b) => b.dailyProfitPercent - a.dailyProfitPercent);
  
  // Update cache
  priceCache.spot = allSpot;
  priceCache.futures = allFutures;
  priceCache.volumes = allVolumes;
  priceCache.fundingRates = allFunding;
  priceCache.opportunities = spotFuturesOpps;
  priceCache.fundingOpps = fundingOpps;
  priceCache.exchangeStats = exchangeStats;
  priceCache.lastUpdate = new Date();
  
  const jupiterOpps = spotFuturesOpps.filter(o => o.isDexInvolved).length;
  const htxOpps = spotFuturesOpps.filter(o => o.spotExchange === 'HTX').length;
  
  console.log(`Found ${spotFuturesOpps.length} spot-futures (${jupiterOpps} Jupiter, ${htxOpps} HTX), ${fundingOpps.length} funding`);
  
  return { spotFuturesOpps, fundingOpps, exchangeStats };
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
      : `https://www.bitget.com/futures/usdt/${symbol}`,
    'HTX': `https://www.htx.com/trade/${base}-usdt`,
    'Jupiter': `https://jup.ag/swap/${base}-USDC`
  };
  
  return urls[exchange] || '#';
}

// ========== User Filters ==========

function getFilters(chatId) {
  if (!userFilters[chatId]) {
    userFilters[chatId] = {
      mode: 'spot-futures',
      minSpread: 0.5,
      minFundingProfit: 0.1,
      minVolume: 0,
      enabledExchanges: [...ALL_EXCHANGES],
      showJupiterOnly: false
    };
  }
  return userFilters[chatId];
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
    [{ text: `📊 Режим: ${f.mode === 'spot-futures' ? 'Spot-Futures' : 'Funding Rate'}`, callback_data: 'select_mode' }],
    f.mode === 'spot-futures' 
      ? [{ text: `📉 Мин. спред: ${f.minSpread}%`, callback_data: 'filter_min_spread' }]
      : [{ text: `💰 Мин. прибыль: ${f.minFundingProfit}%/день`, callback_data: 'filter_funding_profit' }],
    [{ text: `📊 Мин. объём: ${f.minVolume > 0 ? '$' + (f.minVolume/1000).toFixed(0) + 'K' : 'Нет'}`, callback_data: 'filter_min_volume' }],
    [{ text: '💱 Биржи', callback_data: 'filter_exchanges' }],
    [{ text: '🔙 Назад', callback_data: 'back' }]
  ]
});

const getExchangesKb = (enabled) => ({
  inline_keyboard: [
    ...ALL_EXCHANGES.map(ex => [{
      text: `${enabled.includes(ex) ? '✅' : '❌'} ${ex}`,
      callback_data: `toggle_exchange_${ex.replace('.', '')}`
    }]),
    [{ text: '✅ Все', callback_data: 'enable_all' }, { text: '❌ Сброс', callback_data: 'disable_all' }],
    [{ text: '🔙 Назад', callback_data: 'filters' }]
  ]
});

const getModeKb = (currentMode) => ({
  inline_keyboard: [
    [{ text: `${currentMode === 'spot-futures' ? '✅ ' : ''}📈 Spot-Futures`, callback_data: 'set_mode_spot-futures' }],
    [{ text: `${currentMode === 'funding-rate' ? '✅ ' : ''}💰 Funding Rate`, callback_data: 'set_mode_funding-rate' }],
    [{ text: '🔙 Назад', callback_data: 'filters' }]
  ]
});

const getSpreadKb = () => ({
  inline_keyboard: [
    [0.5, 1, 1.5, 2, 2.5].map(v => ({ text: `${v}%`, callback_data: `set_min_spread_${v}` })),
    [3, 4, 5, 7, 10].map(v => ({ text: `${v}%`, callback_data: `set_min_spread_${v}` })),
    [{ text: '🔙 Назад', callback_data: 'filters' }]
  ]
});

const getFundingProfitKb = () => ({
  inline_keyboard: [
    [0.05, 0.1, 0.2, 0.3, 0.5].map(v => ({ text: `${v}%`, callback_data: `set_funding_profit_${v}` })),
    [0.75, 1, 1.5, 2, 3].map(v => ({ text: `${v}%`, callback_data: `set_funding_profit_${v}` })),
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
      `Я SpreadUP Bot v5.1 для арбитража криптовалют.\n\n` +
      `📊 <b>Режимы работы:</b>\n` +
      `• 📈 <b>Spot-Futures</b> - спред между спотом и фьючерсом\n` +
      `• 💰 <b>Funding Rate</b> - разница фандинг рейтов\n\n` +
      `💱 <b>Биржи:</b> MEXC, Gate.io, BingX, Bybit, OKX, Bitget, HTX, Jupiter\n\n` +
      `🆕 <b>HTX</b> (бывшая Huobi) теперь доступна!\n` +
      `🔮 <b>Jupiter</b> - Solana DEX с уникальными токенами!\n\n` +
      `✅ Вы подписаны на уведомления!`,
      mainKeyboard
    );
  } else if (text === '/status') {
    await handleStatus(chatId);
  } else if (text === '/filters') {
    await sendMessage(chatId, '⚙️ <b>Фильтры уведомлений</b>', getFiltersKb(f));
  } else if (text === '/scan') {
    await handleScan(chatId);
  } else if (text === '/top') {
    await handleTop(chatId);
  } else if (text === '/help') {
    await sendMessage(chatId,
      `📖 <b>Справка по SpreadUP Bot v5.1</b>\n\n` +
      `📈 <b>Spot-Futures арбитраж:</b>\n` +
      `Находим мин. цену спота и макс. цену фьючерса.\n\n` +
      `💰 <b>Funding Rate арбитраж:</b>\n` +
      `Находим разницу в funding rate между биржами.\n\n` +
      `💱 <b>Биржи:</b> MEXC, Gate.io, BingX, Bybit, OKX, Bitget, HTX, Jupiter\n\n` +
      `<b>Команды:</b>\n` +
      `/start - Начать работу\n` +
      `/scan - Сканировать рынок\n` +
      `/top - Топ результатов\n` +
      `/filters - Настройки\n` +
      `/status - Статус`,
      mainKeyboard
    );
  } else {
    await sendMessage(chatId, 'Команды: /start, /scan, /top, /filters, /status, /help', mainKeyboard);
  }
}

async function handleStatus(chatId) {
  const lastUpdate = priceCache.lastUpdate 
    ? new Date(priceCache.lastUpdate).toLocaleString('ru-RU')
    : 'Нет данных';
  const f = getFilters(chatId);
  const crossCount = priceCache.opportunities.filter(o => o.isCrossExchange).length;
  const jupiterCount = priceCache.opportunities.filter(o => o.isDexInvolved).length;
  const htxCount = priceCache.opportunities.filter(o => o.spotExchange === 'HTX').length;
  
  let text = `📊 <b>Статус мониторинга v5.1</b>\n\n`;
  text += `🔄 Состояние: ✅ Активен\n`;
  text += `⏱ Последнее обновление: ${lastUpdate}\n\n`;
  
  text += `📈 <b>Spot-Futures:</b>\n`;
  text += `   Всего: ${priceCache.opportunities.length}\n`;
  text += `   🔗 Межбиржевых: ${crossCount}\n`;
  text += `   🔮 С Jupiter: ${jupiterCount}\n`;
  text += `   🆕 С HTX: ${htxCount}\n\n`;
  
  text += `💰 <b>Funding Rate:</b> ${priceCache.fundingOpps.length}\n\n`;
  
  if (priceCache.exchangeStats && Object.keys(priceCache.exchangeStats).length > 0) {
    text += `📊 <b>Данные с бирж:</b>\n`;
    for (const [ex, stats] of Object.entries(priceCache.exchangeStats)) {
      text += `   ${ex}: ${stats.spot} spot, ${stats.futures} futures\n`;
    }
  }
  
  await sendMessage(chatId, text, mainKeyboard);
}

async function handleScan(chatId) {
  await sendMessage(chatId, '🔄 <b>Сканирование рынка...</b>');
  
  const { spotFuturesOpps, fundingOpps } = await scanAllExchanges();
  const f = getFilters(chatId);
  
  if (f.mode === 'spot-futures') {
    await showSpotFuturesResults(chatId, spotFuturesOpps, f);
  } else {
    await showFundingRateResults(chatId, fundingOpps, f);
  }
}

async function showSpotFuturesResults(chatId, opportunities, f) {
  const filtered = opportunities.filter(opp => {
    if (opp.spreadPercent < f.minSpread) return false;
    if (f.minVolume > 0 && opp.volume24h > 0 && opp.volume24h < f.minVolume) return false;
    if (!f.enabledExchanges.includes(opp.spotExchange)) return false;
    if (!f.enabledExchanges.includes(opp.futuresExchange)) return false;
    return true;
  });
  
  if (filtered.length === 0) {
    await sendMessage(chatId,
      `📊 <b>Spot-Futures результаты</b>\n\n` +
      `Найдено: ${opportunities.length}\n` +
      `После фильтрации: 0`,
      mainKeyboard
    );
    return;
  }
  
  let text = `📊 <b>Spot-Futures результаты</b>\n\n`;
  text += `Найдено: ${opportunities.length} | Фильтр: ${filtered.length}\n\n`;
  
  for (let i = 0; i < Math.min(5, filtered.length); i++) {
    const opp = filtered[i];
    const emoji = opp.spreadPercent >= 5 ? '🔥' : opp.spreadPercent >= 2 ? '⚡' : '📊';
    const crossEmoji = opp.isCrossExchange ? '🔗 ' : '';
    const dexEmoji = opp.isDexInvolved ? '🔮 ' : '';
    const htxEmoji = opp.spotExchange === 'HTX' ? '🆕 ' : '';
    
    text += `${i+1}. ${emoji} <b>${opp.baseAsset}</b>: ${opp.spreadPercent.toFixed(2)}%\n`;
    text += `   ${dexEmoji}${htxEmoji}${crossEmoji}${opp.spotExchange} → ${opp.futuresExchange}\n`;
    text += `   Spot: $${formatPrice(opp.spotPrice)} | Futures: $${formatPrice(opp.futuresPrice)}\n\n`;
  }
  
  await sendMessage(chatId, text, mainKeyboard);
}

async function showFundingRateResults(chatId, opportunities, f) {
  const filtered = opportunities.filter(opp => {
    if (opp.dailyProfitPercent < f.minFundingProfit) return false;
    if (!f.enabledExchanges.includes(opp.longExchange)) return false;
    if (!f.enabledExchanges.includes(opp.shortExchange)) return false;
    return true;
  });
  
  if (filtered.length === 0) {
    await sendMessage(chatId,
      `💰 <b>Funding Rate результаты</b>\n\n` +
      `Найдено: ${opportunities.length}\n` +
      `После фильтрации: 0`,
      mainKeyboard
    );
    return;
  }
  
  let text = `💰 <b>Funding Rate результаты</b>\n\n`;
  text += `Найдено: ${opportunities.length} | Фильтр: ${filtered.length}\n\n`;
  
  for (let i = 0; i < Math.min(8, filtered.length); i++) {
    const opp = filtered[i];
    const emoji = opp.dailyProfitPercent >= 1 ? '🔥' : opp.dailyProfitPercent >= 0.5 ? '⚡' : '📊';
    
    text += `${i+1}. ${emoji} <b>${opp.baseAsset}</b>: +${opp.dailyProfitPercent.toFixed(2)}%/день\n`;
    text += `   Long: ${opp.longExchange} (${(opp.longRate * 100).toFixed(3)}%)\n`;
    text += `   Short: ${opp.shortExchange} (${(opp.shortRate * 100).toFixed(3)}%)\n\n`;
  }
  
  await sendMessage(chatId, text, mainKeyboard);
}

async function handleTop(chatId) {
  const f = getFilters(chatId);
  
  if (priceCache.lastUpdate === null) {
    await sendMessage(chatId, '📊 Нет данных. Используйте /scan.', mainKeyboard);
    return;
  }
  
  if (f.mode === 'spot-futures') {
    await showSpotFuturesResults(chatId, priceCache.opportunities, f);
  } else {
    await showFundingRateResults(chatId, priceCache.fundingOpps, f);
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
    await handleStatus(chatId);
  } else if (data === 'filters') {
    await sendMessage(chatId, '⚙️ Фильтры', getFiltersKb(f));
  } else if (data === 'scan') {
    await handleScan(chatId);
  } else if (data === 'top') {
    await handleTop(chatId);
  } else if (data === 'select_mode') {
    await sendMessage(chatId, '📊 <b>Выберите режим:</b>', getModeKb(f.mode));
  } else if (data === 'set_mode_spot-futures') {
    f.mode = 'spot-futures';
    await sendMessage(chatId, '✅ Режим: Spot-Futures', getFiltersKb(f));
  } else if (data === 'set_mode_funding-rate') {
    f.mode = 'funding-rate';
    await sendMessage(chatId, '✅ Режим: Funding Rate', getFiltersKb(f));
  } else if (data === 'filter_min_spread') {
    await sendMessage(chatId, '📉 <b>Минимальный спред</b>', getSpreadKb());
  } else if (data === 'filter_funding_profit') {
    await sendMessage(chatId, '💰 <b>Минимальная прибыль в день</b>', getFundingProfitKb());
  } else if (data === 'filter_min_volume') {
    await sendMessage(chatId, '📊 <b>Минимальный объём</b>', getVolumeKb());
  } else if (data === 'filter_exchanges') {
    await sendMessage(chatId, '💱 <b>Выберите биржи</b>', getExchangesKb(f.enabledExchanges));
  } else if (data.startsWith('set_min_spread_')) {
    f.minSpread = parseFloat(data.replace('set_min_spread_', ''));
    await sendMessage(chatId, `📉 Мин. спред: ${f.minSpread}%`, getFiltersKb(f));
  } else if (data.startsWith('set_funding_profit_')) {
    f.minFundingProfit = parseFloat(data.replace('set_funding_profit_', ''));
    await sendMessage(chatId, `💰 Мин. прибыль: ${f.minFundingProfit}%/день`, getFiltersKb(f));
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
    f.enabledExchanges = [...ALL_EXCHANGES];
    await sendMessage(chatId, '✅ Все биржи включены', getExchangesKb(f.enabledExchanges));
  } else if (data === 'disable_all') {
    f.enabledExchanges = [];
    await sendMessage(chatId, '❌ Все биржи отключены', getExchangesKb(f.enabledExchanges));
  }
}

// ========== Alerts ==========

async function sendAlerts(spotFuturesOpps, fundingOpps) {
  const subscribers = Object.keys(userSubscribed).filter(id => userSubscribed[id]);
  if (subscribers.length === 0) return;
  
  const now = Date.now();
  const cooldownMs = 20 * 60 * 1000;
  
  for (const opp of spotFuturesOpps) {
    if (opp.spreadPercent < 3) continue;
    
    const assetKey = `sf_${opp.baseAsset}`;
    if (lastAlertTime[assetKey] && (now - lastAlertTime[assetKey]) < cooldownMs) continue;
    
    const message = `
🔥 <b>АРБИТРАЖ!</b>

📊 <b>${opp.baseAsset}/USDT</b>
📈 Спред: ${opp.spreadPercent.toFixed(2)}%

💰 Spot (${opp.spotExchange}): $${formatPrice(opp.spotPrice)}
💰 Futures (${opp.futuresExchange}): $${formatPrice(opp.futuresPrice)}

🔗 <a href="${opp.spotUrl}">Spot</a> | <a href="${opp.futuresUrl}">Futures</a>
`;
    
    for (const chatId of subscribers) {
      const filters = getFilters(chatId);
      if (filters.mode !== 'spot-futures') continue;
      if (opp.spreadPercent < filters.minSpread) continue;
      
      try {
        await sendMessage(chatId, message);
      } catch (e) {}
    }
    
    lastAlertTime[assetKey] = now;
  }
}

function formatPrice(price) {
  if (price >= 1000) return price.toFixed(2);
  if (price >= 1) return price.toFixed(4);
  if (price >= 0.0001) return price.toFixed(6);
  return price.toFixed(8);
}

// ========== Main Handler ==========

export default async function handler(req, res) {
  if (req.method === 'GET') {
    const { cron } = req.query;
    
    if (cron === 'scan') {
      try {
        const { spotFuturesOpps, fundingOpps } = await scanAllExchanges();
        await sendAlerts(spotFuturesOpps, fundingOpps);
        return res.status(200).json({ 
          status: 'scanned',
          spotFutures: spotFuturesOpps.length,
          fundingRate: fundingOpps.length,
          jupiterOpps: spotFuturesOpps.filter(o => o.isDexInvolved).length,
          htxOpps: spotFuturesOpps.filter(o => o.spotExchange === 'HTX').length,
          exchangeStats: priceCache.exchangeStats,
          timestamp: new Date().toISOString()
        });
      } catch (e) {
        console.error('Cron error:', e);
        return res.status(500).json({ error: e.message });
      }
    }
    
    return res.status(200).json({
      status: 'SpreadUP Bot Active',
      version: '5.1.0',
      exchanges: ALL_EXCHANGES,
      spotFuturesOpps: priceCache.opportunities.length,
      fundingOpps: priceCache.fundingOpps.length,
      lastUpdate: priceCache.lastUpdate,
      exchangeStats: priceCache.exchangeStats
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
