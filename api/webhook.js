/**
 * SpreadUP Bot v6.0 - Multi-Mode Arbitrage Scanner
 * 
 * Modes:
 * 1. Spot-Futures - Spot to Futures arbitrage
 * 2. Futures-Futures - Cross-exchange futures arbitrage
 * 3. Funding Rate - Funding rate arbitrage
 * 4. Price vs Fair Price - Deviation from weighted average price
 * 5. Triangular Arbitrage - Intra-exchange triangle arb
 * 
 * Exchanges: MEXC, Gate.io, BingX, Bybit, OKX, Bitget, HTX, Lbank, KuCoin, Jupiter
 * 
 * Filters:
 * - Max spread 20% to filter out junk/scam tokens
 * - Min volume 500K USDT by default
 */

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8476184475:AAEka7mj2waSrH1XV4z-PWwuMFxwTVVsbHg';
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

// MAX SPREAD LOCK - Filter out unrealistic spreads (likely junk tokens)
const MAX_SPREAD_PERCENT = 20;

// MIN LIQUIDITY for triangular arbitrage - Each pair must have ≥ 500K USDT volume
const MIN_TRIANGLE_LIQUIDITY = 500000;

// Whitelist of known liquid assets for triangular arbitrage
// Only these assets can be used as midAsset or finalAsset in triangles
const LIQUID_ASSETS = new Set([
  // Top cryptocurrencies by market cap
  'BTC', 'ETH', 'BNB', 'SOL', 'XRP', 'ADA', 'DOGE', 'AVAX', 'DOT', 'MATIC',
  'LINK', 'UNI', 'ATOM', 'LTC', 'ETC', 'NEAR', 'AAVE', 'FIL', 'ARB', 'OP',
  'APT', 'SUI', 'SEI', 'INJ', 'TIA', 'TIA', 'WLD', 'PEPE', 'FLOKI', 'BONK',
  'SHIB', 'WIF', 'POPCAT', 'JUP', 'RAY', 'ORCA', 'RENDER', 'IMX', 'GALA',
  'SAND', 'MANA', 'AXS', 'GRT', 'ALGO', 'VET', 'HBAR', 'ICP', 'FET', 'RNDR',
  'STX', 'RUNE', 'THETA', 'FTM', 'ENS', 'LDO', 'BLUR', '1INCH', 'COMP',
  'SUSHI', 'CRV', 'SNX', 'MKR', 'YFI', 'KAVA', 'RUNE', 'CAKE', 'DYDX',
  'LOOKS', 'GMX', 'PENDLE', 'AERO', 'VELO', 'AERO', 'ENS', 'API3', 'CVX',
  // Stablecoins
  'USDC', 'USDT', 'DAI', 'BUSD', 'TUSD'
]);

// Global cache
let priceCache = {
  spot: {},
  futures: {},
  volumes: {},
  fundingRates: {},
  allPairs: {}, // All trading pairs for triangular arb
  lastUpdate: null,
  opportunities: [],
  futuresFuturesOpps: [],
  fundingOpps: [],
  fairPriceOpps: [],
  triangularOpps: [],
  exchangeStats: {}
};

// User storage
const userFilters = {};
const userSubscribed = {};
const lastAlertTime = {};

// All supported exchanges (10 total)
const ALL_EXCHANGES = ['MEXC', 'Gate.io', 'BingX', 'Bybit', 'OKX', 'Bitget', 'HTX', 'Lbank', 'KuCoin', 'Jupiter'];
const FUTURES_EXCHANGES = ['MEXC', 'Gate.io', 'BingX', 'Bybit', 'OKX', 'Bitget'];

// Exchanges that support triangular arbitrage (have many pairs)
const TRIANGLE_EXCHANGES = ['MEXC', 'Gate.io', 'OKX', 'Bybit', 'Bitget', 'KuCoin'];

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
    
    const spot = {}, futures = {}, volumes = {}, funding = {}, allPairs = {};
    
    // All pairs for triangular arbitrage
    for (const item of spotData) {
      const symbol = item.symbol;
      const price = parseFloat(item.lastPrice);
      const vol = parseFloat(item.quoteVolume) || 0;
      
      if (price > 0) {
        allPairs[symbol] = { price, volume: vol };
        
        // Also store USDT pairs for other modes
        if (symbol.endsWith('USDT')) {
          spot[symbol] = price;
          volumes[symbol] = vol;
        }
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
    
    return { spot, futures, volumes, funding, allPairs, exchange: 'MEXC' };
  } catch (e) {
    console.error('MEXC error:', e.message);
    return { spot: {}, futures: {}, volumes: {}, funding: {}, allPairs: {}, exchange: 'MEXC' };
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
    
    const spot = {}, futures = {}, volumes = {}, funding = {}, allPairs = {};
    
    for (const item of spotData) {
      const pair = item.currency_pair;
      const price = parseFloat(item.last);
      const vol = parseFloat(item.quote_volume) || 0;
      
      if (price > 0) {
        // Convert BTC_USDT to BTCUSDT format
        const symbol = pair.replace('_', '');
        allPairs[symbol] = { price, volume: vol };
        
        if (pair.endsWith('_USDT')) {
          spot[symbol] = price;
          volumes[symbol] = vol;
        }
      }
    }
    
    for (const item of futuresData) {
      if (!item.in_delisting) {
        const symbol = item.name.replace('_', '');
        futures[symbol] = parseFloat(item.last_price);
        funding[symbol] = parseFloat(item.funding_rate) || 0;
      }
    }
    
    return { spot, futures, volumes, funding, allPairs, exchange: 'Gate.io' };
  } catch (e) {
    console.error('Gate.io error:', e.message);
    return { spot: {}, futures: {}, volumes: {}, funding: {}, allPairs: {}, exchange: 'Gate.io' };
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
    
    const spot = {}, futures = {}, volumes = {}, funding = {}, allPairs = {};
    
    if (spotData.data) {
      for (const item of spotData.data) {
        const pair = item.symbol;
        const price = parseFloat(item.lastPrice);
        const vol = parseFloat(item.quoteVolume) || 0;
        
        if (price > 0) {
          const symbol = pair.replace('-', '');
          allPairs[symbol] = { price, volume: vol };
          
          if (pair.endsWith('-USDT')) {
            spot[symbol] = price;
            volumes[symbol] = vol;
          }
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
    
    return { spot, futures, volumes, funding, allPairs, exchange: 'BingX' };
  } catch (e) {
    console.error('BingX error:', e.message);
    return { spot: {}, futures: {}, volumes: {}, funding: {}, allPairs: {}, exchange: 'BingX' };
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
    
    const spot = {}, futures = {}, volumes = {}, funding = {}, allPairs = {};
    
    if (spotData.result?.list) {
      for (const item of spotData.result.list) {
        const symbol = item.symbol;
        const price = parseFloat(item.lastPrice);
        const vol = parseFloat(item.turnover24h) || 0;
        
        if (price > 0) {
          allPairs[symbol] = { price, volume: vol };
          
          if (symbol.endsWith('USDT')) {
            spot[symbol] = price;
            volumes[symbol] = vol;
          }
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
    
    return { spot, futures, volumes, funding, allPairs, exchange: 'Bybit' };
  } catch (e) {
    console.error('Bybit error:', e.message);
    return { spot: {}, futures: {}, volumes: {}, funding: {}, allPairs: {}, exchange: 'Bybit' };
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
    
    const spot = {}, futures = {}, volumes = {}, funding = {}, allPairs = {};
    
    if (spotData.data) {
      for (const item of spotData.data) {
        const instId = item.instId;
        const price = parseFloat(item.last);
        const vol = parseFloat(item.vol24h) * price || 0;
        
        if (price > 0) {
          // Convert BTC-USDT to BTCUSDT
          const symbol = instId.replace('-', '');
          allPairs[symbol] = { price, volume: vol };
          
          if (instId.endsWith('-USDT')) {
            spot[symbol] = price;
            volumes[symbol] = vol;
          }
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
    
    return { spot, futures, volumes, funding, allPairs, exchange: 'OKX' };
  } catch (e) {
    console.error('OKX error:', e.message);
    return { spot: {}, futures: {}, volumes: {}, funding: {}, allPairs: {}, exchange: 'OKX' };
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
    
    const spot = {}, futures = {}, volumes = {}, funding = {}, allPairs = {};
    
    if (spotData.data) {
      for (const item of spotData.data) {
        const symbol = item.symbol;
        const price = parseFloat(item.lastPr);
        const vol = parseFloat(item.baseVolume) * price || 0;
        
        if (price > 0) {
          allPairs[symbol] = { price, volume: vol };
          
          if (symbol.endsWith('USDT')) {
            spot[symbol] = price;
            volumes[symbol] = vol;
          }
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
    
    return { spot, futures, volumes, funding, allPairs, exchange: 'Bitget' };
  } catch (e) {
    console.error('Bitget error:', e.message);
    return { spot: {}, futures: {}, volumes: {}, funding: {}, allPairs: {}, exchange: 'Bitget' };
  }
}

// HTX (Huobi) - Only spot
async function fetchHTXPrices() {
  try {
    const spot = {}, volumes = {}, allPairs = {};
    
    const symbols = [
      'btcusdt', 'ethusdt', 'solusdt', 'bnbusdt', 'xrpusdt', 'adausdt', 'dogeusdt',
      'avaxusdt', 'dotusdt', 'maticusdt', 'linkusdt', 'uniusdt', 'atomusdt', 'ltcusdt',
      'etcusdt', 'nearusdt', 'aaveusdt', 'filusdt', 'arbusdt', 'opusdt', 'aptusdt',
      'suiusdt', 'seiusdt', 'wldusdt', 'pepeusdt', 'flokiusdt', 'injusdt', 'samusdt',
      'shibusdt', 'bonkusdt', 'jupusdt', 'wifusdt', 'popcatusdt', 'neirusdt', 'taousdt',
      'btceth', 'ethbtc' // Cross pairs for triangular
    ];
    
    const fetchPromises = symbols.map(async (sym) => {
      try {
        const res = await fetch(`https://api.htx.com/market/detail/merged?symbol=${sym}`, {
          signal: AbortSignal.timeout(10000)
        });
        const data = await res.json();
        
        if (data.status === 'ok' && data.tick) {
          const symbol = sym.toUpperCase();
          const price = parseFloat(data.tick.close);
          const vol = parseFloat(data.tick.vol) || 0;
          
          if (price > 0) {
            // Normalize symbol format
            let normalizedSymbol = symbol;
            if (!symbol.includes('USDT') && !symbol.includes('BTC') && !symbol.includes('ETH')) {
              normalizedSymbol = symbol + 'USDT';
            }
            
            return { symbol: normalizedSymbol, price, vol };
          }
        }
      } catch (e) {}
      return null;
    });
    
    const results = await Promise.all(fetchPromises);
    
    for (const result of results) {
      if (result) {
        allPairs[result.symbol] = { price: result.price, volume: result.vol };
        
        if (result.symbol.endsWith('USDT')) {
          spot[result.symbol] = result.price;
          volumes[result.symbol] = result.vol;
        }
      }
    }
    
    console.log(`HTX: ${Object.keys(spot).length} spot, ${Object.keys(allPairs).length} pairs`);
    return { spot, futures: {}, volumes, funding: {}, allPairs, exchange: 'HTX' };
  } catch (e) {
    console.error('HTX error:', e.message);
    return { spot: {}, futures: {}, volumes: {}, funding: {}, allPairs: {}, exchange: 'HTX' };
  }
}

// Lbank - Only spot
async function fetchLbankPrices() {
  try {
    const spot = {}, volumes = {}, allPairs = {};
    
    const res = await fetch('https://api.lbank.info/v2/supplement/ticker/price.do', {
      signal: AbortSignal.timeout(15000)
    });
    const data = await res.json();
    
    if (data.result && data.data) {
      for (const item of data.data) {
        const symbolStr = item.symbol || '';
        if (symbolStr.endsWith('_usdt')) {
          const base = symbolStr.replace('_usdt', '').toUpperCase();
          const symbol = base + 'USDT';
          const price = parseFloat(item.price);
          
          if (price > 0 && base.length >= 2 && base.length <= 10) {
            spot[symbol] = price;
            volumes[symbol] = 0;
            allPairs[symbol] = { price, volume: 0 };
          }
        }
      }
    }
    
    console.log(`Lbank: ${Object.keys(spot).length} spot`);
    return { spot, futures: {}, volumes, funding: {}, allPairs, exchange: 'Lbank' };
  } catch (e) {
    console.error('Lbank error:', e.message);
    return { spot: {}, futures: {}, volumes: {}, funding: {}, allPairs: {}, exchange: 'Lbank' };
  }
}

// KuCoin - Spot only
async function fetchKuCoinPrices() {
  try {
    const spot = {}, volumes = {}, allPairs = {};
    
    const res = await fetch('https://api.kucoin.com/api/v1/market/allTickers', {
      signal: AbortSignal.timeout(15000)
    });
    const data = await res.json();
    
    if (data.code === '200000' && data.data?.ticker) {
      for (const item of data.data.ticker) {
        const symbolPair = item.symbol || '';
        const price = parseFloat(item.last);
        const vol = parseFloat(item.volValue) || 0;
        
        if (price > 0) {
          // Convert BTC-USDT to BTCUSDT
          const symbol = symbolPair.replace('-', '');
          allPairs[symbol] = { price, volume: vol };
          
          if (symbolPair.endsWith('-USDT')) {
            spot[symbol] = price;
            volumes[symbol] = vol;
          }
        }
      }
    }
    
    console.log(`KuCoin: ${Object.keys(spot).length} spot, ${Object.keys(allPairs).length} pairs`);
    return { spot, futures: {}, volumes, funding: {}, allPairs, exchange: 'KuCoin' };
  } catch (e) {
    console.error('KuCoin error:', e.message);
    return { spot: {}, futures: {}, volumes: {}, funding: {}, allPairs: {}, exchange: 'KuCoin' };
  }
}

// Jupiter (Solana DEX via Dexscreener)
async function fetchJupiterPrices() {
  try {
    const spot = {}, volumes = {}, allPairs = {};
    
    const popularTokens = [
      { symbol: 'SOL', address: 'So11111111111111111111111111111111111111112' },
      { symbol: 'BONK', address: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263' },
      { symbol: 'WIF', address: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm' },
      { symbol: 'JUP', address: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN' },
      { symbol: 'RAY', address: '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R' },
      { symbol: 'ORCA', address: 'orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE' },
      { symbol: 'RENDER', address: 'rndrizKT3MK1iimdxRmWzYBfFW6E3kVvkdZ1uWgjThq' },
      { symbol: 'POPCAT', address: '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr' }
    ];
    
    const fetchPromises = popularTokens.map(async (token) => {
      try {
        const tokenRes = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${token.address}`);
        const tokenData = await tokenRes.json();
        
        if (tokenData.pairs && tokenData.pairs.length > 0) {
          const bestPair = tokenData.pairs
            .filter(p => p.chainId === 'solana' && (p.quoteToken?.symbol === 'USDC' || p.quoteToken?.symbol === 'USDT') && p.liquidity?.usd > 10000)
            .sort((a, b) => (parseFloat(b.liquidity?.usd || 0)) - (parseFloat(a.liquidity?.usd || 0)))[0];
          
          if (bestPair && bestPair.priceUsd) {
            const price = parseFloat(bestPair.priceUsd);
            if (price > 0) return { symbol: token.symbol + 'USDT', price, volume: parseFloat(bestPair.volume?.h24 || 0) };
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
        allPairs[result.symbol] = { price: result.price, volume: result.volume };
      }
    }
    
    console.log(`Jupiter: ${Object.keys(spot).length} DEX`);
    return { spot, futures: {}, volumes, funding: {}, allPairs, exchange: 'Jupiter' };
  } catch (e) {
    console.error('Jupiter error:', e.message);
    return { spot: {}, futures: {}, volumes: {}, funding: {}, allPairs: {}, exchange: 'Jupiter' };
  }
}

// ========== Triangular Arbitrage Calculation ==========

function findTriangularOpportunities(allPairs, exchange) {
  const opportunities = [];
  const pairs = Object.keys(allPairs);
  
  // Debug counters
  let totalTriangles = 0;
  let filteredByWhitelist = 0;
  let filteredByLiquidity = 0;
  let filteredByProfit = 0;
  
  // Common quote currencies for triangles
  const quotes = ['USDT', 'BTC', 'ETH', 'USDC', 'BNB'];
  
  // Build pair lookup
  const pairMap = {};
  for (const pair of pairs) {
    pairMap[pair] = allPairs[pair];
  }
  
  // Find all possible triangles starting from USDT
  for (const midAsset of ['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'DOGE', 'ADA', 'AVAX', 'MATIC', 'LINK']) {
    // Triangle: USDT -> midAsset -> finalAsset -> USDT
    const pair1 = midAsset + 'USDT';  // Buy midAsset with USDT
    const pair1Alt = 'USDT' + midAsset; // Alternative naming
    
    if (!pairMap[pair1] && !pairMap[pair1Alt]) continue;
    
    // Get midAsset price in USDT
    const midPriceUSDT = pairMap[pair1]?.price || (pairMap[pair1Alt] ? 1 / pairMap[pair1Alt].price : 0);
    if (midPriceUSDT <= 0) continue;
    
    // Find all pairs with midAsset
    for (const pair of pairs) {
      let finalAsset = null;
      let pair2Price = 0;
      let pair2Volume = 0;
      
      // Check if pair contains midAsset
      if (pair.startsWith(midAsset) && pair !== pair1 && pair !== pair1Alt) {
        // Pair is midAsset/Something (e.g., BTCETH)
        finalAsset = pair.replace(midAsset, '');
        if (finalAsset === 'USDT' || finalAsset === midAsset) continue;
        pair2Price = pairMap[pair].price;
        pair2Volume = pairMap[pair].volume || 0;
      } else if (pair.endsWith(midAsset) && pair !== pair1 && pair !== pair1Alt) {
        // Pair is Something/midAsset (e.g., ETHBTC)
        finalAsset = pair.replace(midAsset, '');
        if (finalAsset === 'USDT' || finalAsset === midAsset) continue;
        pair2Price = 1 / pairMap[pair].price; // Inverse
        pair2Volume = pairMap[pair].volume || 0;
      }
      
      if (!finalAsset || finalAsset.length < 2 || finalAsset.length > 6) continue;
      
      // ===== WHITELIST CHECK - Only known liquid assets =====
      if (!LIQUID_ASSETS.has(midAsset)) continue;
      if (!LIQUID_ASSETS.has(finalAsset)) continue;
      
      // Check if we can sell finalAsset for USDT
      const pair3 = finalAsset + 'USDT';
      const pair3Alt = 'USDT' + finalAsset;
      
      if (!pairMap[pair3] && !pairMap[pair3Alt]) continue;
      
      const finalPriceUSDT = pairMap[pair3]?.price || (pairMap[pair3Alt] ? 1 / pairMap[pair3Alt].price : 0);
      if (finalPriceUSDT <= 0) continue;
      
      // ===== LIQUIDITY CHECK =====
      // For USDT pairs (pair1, pair3): require 500K volume
      // For cross-pairs (pair2): require only 50K (they naturally have less volume)
      const MIN_USDT_PAIR_LIQUIDITY = MIN_TRIANGLE_LIQUIDITY;  // 500K
      const MIN_CROSS_PAIR_LIQUIDITY = 50000;  // 50K for non-USDT pairs
      
      const pair1Volume = pairMap[pair1]?.volume || pairMap[pair1Alt]?.volume || 0;
      const pair3Volume = pairMap[pair3]?.volume || pairMap[pair3Alt]?.volume || 0;
      
      // Skip if USDT pairs have insufficient liquidity
      if (pair1Volume < MIN_USDT_PAIR_LIQUIDITY) continue;
      if (pair3Volume < MIN_USDT_PAIR_LIQUIDITY) continue;
      
      // For cross-pair, require lower threshold
      if (pair2Volume < MIN_CROSS_PAIR_LIQUIDITY) continue;
      
      // Calculate triangle profit
      // Start with 1000 USDT
      const startAmount = 1000;
      
      // Step 1: Buy midAsset with USDT
      const midAmount = startAmount / midPriceUSDT;
      
      // Step 2: Trade midAsset for finalAsset
      const finalAmount = midAmount * pair2Price;
      
      // Step 3: Sell finalAsset for USDT
      const endAmount = finalAmount * finalPriceUSDT;
      
      // Calculate profit percentage
      const profitPercent = ((endAmount - startAmount) / startAmount) * 100;
      
      // Filter: only show profitable triangles with reasonable profit
      if (profitPercent > 0.3 && profitPercent <= MAX_SPREAD_PERCENT) {
        opportunities.push({
          type: 'triangular',
          exchange,
          path: `USDT → ${midAsset} → ${finalAsset} → USDT`,
          midAsset,
          finalAsset,
          startAmount,
          endAmount,
          profitPercent,
          pair1Volume,
          pair2Volume,
          pair3Volume,
          volume24h: Math.max(pair1Volume, pair2Volume, pair3Volume),
          steps: [
            { pair: pair1 || pair1Alt, action: 'buy', asset: midAsset, price: midPriceUSDT, volume: pair1Volume },
            { pair: pair, action: 'trade', asset: finalAsset, price: pair2Price, volume: pair2Volume },
            { pair: pair3 || pair3Alt, action: 'sell', asset: 'USDT', price: finalPriceUSDT, volume: pair3Volume }
          ]
        });
      }
    }
  }
  
  // Sort by profit
  opportunities.sort((a, b) => b.profitPercent - a.profitPercent);
  
  // Debug output
  if (opportunities.length > 0 || totalTriangles > 0) {
    console.log(`[${exchange}] Triangles: ${opportunities.length} found | Total checked: ${totalTriangles} | Whitelist filter: ${filteredByWhitelist} | Liquidity filter: ${filteredByLiquidity} | Profit filter: ${filteredByProfit}`);
  }
  
  return opportunities;
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
    fetchLbankPrices(),
    fetchKuCoinPrices(),
    fetchJupiterPrices()
  ]);
  
  const allSpot = {}, allFutures = {}, allVolumes = {}, allFunding = {}, allExchangePairs = {};
  const exchangeStats = {};
  
  for (const { spot, futures, volumes, funding, allPairs, exchange } of results) {
    exchangeStats[exchange] = {
      spot: Object.keys(spot).length,
      futures: Object.keys(futures).length,
      pairs: Object.keys(allPairs || {}).length
    };
    
    // Store all pairs for triangular arbitrage
    if (allPairs && TRIANGLE_EXCHANGES.includes(exchange)) {
      allExchangePairs[exchange] = allPairs;
    }
    
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
  
  // === 1. Spot-Futures Opportunities ===
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
    
    if (spread > 0 && spread <= MAX_SPREAD_PERCENT) {
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
        volume24h: allVolumes[symbol] || 0,
        spotUrl: getUrl(bestSpot, symbol, 'spot'),
        futuresUrl: getUrl(bestFutures, symbol, 'futures'),
        allSpotPrices: spotPrices,
        allFuturesPrices: futuresPrices
      });
    }
  }
  
  spotFuturesOpps.sort((a, b) => b.spreadPercent - a.spreadPercent);
  
  // === 2. Futures-Futures Opportunities ===
  const futuresFuturesOpps = [];
  
  for (const symbol in allFutures) {
    const futuresPrices = allFutures[symbol];
    if (Object.keys(futuresPrices).length < 2) continue;
    
    let lowEx = null, lowPrice = Infinity;
    let highEx = null, highPrice = 0;
    
    for (const ex of FUTURES_EXCHANGES) {
      if (futuresPrices[ex] && futuresPrices[ex] > 0) {
        if (futuresPrices[ex] < lowPrice) {
          lowPrice = futuresPrices[ex];
          lowEx = ex;
        }
        if (futuresPrices[ex] > highPrice) {
          highPrice = futuresPrices[ex];
          highEx = ex;
        }
      }
    }
    
    if (!lowEx || !highEx || lowEx === highEx) continue;
    if (lowPrice <= 0 || highPrice <= 0) continue;
    
    const spread = ((highPrice - lowPrice) / lowPrice) * 100;
    
    if (spread > 0 && spread <= MAX_SPREAD_PERCENT) {
      futuresFuturesOpps.push({
        type: 'futures-futures',
        symbol,
        baseAsset: symbol.replace('USDT', ''),
        lowPrice,
        highPrice,
        spreadPercent: spread,
        buyExchange: lowEx,
        sellExchange: highEx,
        volume24h: allVolumes[symbol] || 0,
        buyUrl: getUrl(lowEx, symbol, 'futures'),
        sellUrl: getUrl(highEx, symbol, 'futures'),
        allFuturesPrices: futuresPrices
      });
    }
  }
  
  futuresFuturesOpps.sort((a, b) => b.spreadPercent - a.spreadPercent);
  
  // === 3. Funding Rate Opportunities ===
  const fundingOpps = [];
  
  for (const symbol in allFunding) {
    const rates = allFunding[symbol];
    const futuresPrices = allFutures[symbol];
    if (!futuresPrices) continue;
    
    let maxRate = -Infinity, maxEx = null;
    let minRate = Infinity, minEx = null;
    
    for (const ex of FUTURES_EXCHANGES) {
      if (rates[ex] !== undefined && futuresPrices[ex]) {
        if (rates[ex] > maxRate) { maxRate = rates[ex]; maxEx = ex; }
        if (rates[ex] < minRate) { minRate = rates[ex]; minEx = ex; }
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
  
  // === 4. Price vs Fair Price Opportunities ===
  const fairPriceOpps = [];
  
  for (const symbol in allSpot) {
    const spotPrices = allSpot[symbol];
    const exchanges = Object.keys(spotPrices);
    
    if (exchanges.length < 2) continue;
    
    let totalVolume = 0;
    let weightedSum = 0;
    
    for (const ex of exchanges) {
      const price = spotPrices[ex];
      const vol = allVolumes[symbol] || 100000;
      if (price > 0) {
        weightedSum += price * vol;
        totalVolume += vol;
      }
    }
    
    if (totalVolume === 0) continue;
    
    const fairPrice = weightedSum / totalVolume;
    
    let maxDeviation = 0;
    let maxDevEx = null;
    let maxDevPrice = 0;
    let minDeviation = 0;
    let minDevEx = null;
    let minDevPrice = 0;
    
    for (const ex of exchanges) {
      const price = spotPrices[ex];
      if (price <= 0 || !fairPrice) continue;
      
      const deviation = ((price - fairPrice) / fairPrice) * 100;
      
      if (Math.abs(deviation) > MAX_SPREAD_PERCENT) continue;
      
      if (deviation > maxDeviation) {
        maxDeviation = deviation;
        maxDevEx = ex;
        maxDevPrice = price;
      }
      if (deviation < minDeviation) {
        minDeviation = deviation;
        minDevEx = ex;
        minDevPrice = price;
      }
    }
    
    if (maxDevEx && minDevEx && Math.abs(maxDeviation - minDeviation) >= 0.3) {
      fairPriceOpps.push({
        type: 'fair-price',
        symbol,
        baseAsset: symbol.replace('USDT', ''),
        fairPrice,
        overvaluedExchange: maxDevEx,
        overvaluedPrice: maxDevPrice,
        overvaluedDeviation: maxDeviation,
        undervaluedExchange: minDevEx,
        undervaluedPrice: minDevPrice,
        undervaluedDeviation: minDeviation,
        spreadPercent: maxDeviation - minDeviation,
        volume24h: allVolumes[symbol] || 0,
        allSpotPrices: spotPrices
      });
    }
  }
  
  fairPriceOpps.sort((a, b) => b.spreadPercent - a.spreadPercent);
  
  // === 5. Triangular Arbitrage Opportunities ===
  const triangularOpps = [];
  
  console.log(`[TRI] Checking ${TRIANGLE_EXCHANGES.length} exchanges for triangles...`);
  
  for (const exchange of TRIANGLE_EXCHANGES) {
    const pairs = allExchangePairs[exchange];
    if (pairs) {
      const pairCount = Object.keys(pairs).length;
      console.log(`[TRI] ${exchange}: ${pairCount} pairs available`);
      const triangles = findTriangularOpportunities(pairs, exchange);
      console.log(`[TRI] ${exchange}: found ${triangles.length} triangles`);
      triangularOpps.push(...triangles);
    } else {
      console.log(`[TRI] ${exchange}: NO PAIRS DATA`);
    }
  }
  
  // Sort by profit and take top opportunities
  triangularOpps.sort((a, b) => b.profitPercent - a.profitPercent);
  
  // Update cache
  priceCache.spot = allSpot;
  priceCache.futures = allFutures;
  priceCache.volumes = allVolumes;
  priceCache.fundingRates = allFunding;
  priceCache.allPairs = allExchangePairs;
  priceCache.opportunities = spotFuturesOpps;
  priceCache.futuresFuturesOpps = futuresFuturesOpps;
  priceCache.fundingOpps = fundingOpps;
  priceCache.fairPriceOpps = fairPriceOpps;
  priceCache.triangularOpps = triangularOpps;
  priceCache.exchangeStats = exchangeStats;
  priceCache.lastUpdate = new Date();
  
  console.log(`Found: ${spotFuturesOpps.length} spot-futures, ${futuresFuturesOpps.length} futures-futures, ${fundingOpps.length} funding, ${fairPriceOpps.length} fair-price, ${triangularOpps.length} triangular`);
  
  return { spotFuturesOpps, futuresFuturesOpps, fundingOpps, fairPriceOpps, triangularOpps, exchangeStats };
}

function getUrl(exchange, symbol, type) {
  const base = symbol.replace('USDT', '');
  const isSpot = type === 'spot';
  
  const urls = {
    'MEXC': isSpot ? `https://www.mexc.com/exchange/${symbol}` : `https://www.mexc.com/futures/${base}USDT`,
    'Gate.io': isSpot ? `https://www.gate.io/trade/${base}_USDT` : `https://www.gate.io/futures_trade/USDT/${base}_USDT`,
    'BingX': isSpot ? `https://bingx.com/en-us/spot/${base}-USDT` : `https://bingx.com/en-us/futures/${base}-USDT`,
    'Bybit': isSpot ? `https://www.bybit.com/trade/spot/${symbol}` : `https://www.bybit.com/trade/usdt/${symbol}`,
    'OKX': isSpot ? `https://www.okx.com/trade-spot/${base}-USDT` : `https://www.okx.com/trade-swap/${base}-USDT-SWAP`,
    'Bitget': isSpot ? `https://www.bitget.com/spot/${symbol}` : `https://www.bitget.com/futures/usdt/${symbol}`,
    'HTX': `https://www.htx.com/trade/${base}-usdt`,
    'Lbank': `https://www.lbank.com/trade/${base}_usdt`,
    'KuCoin': `https://www.kucoin.com/trade/${base}-USDT`,
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
      minVolume: 500000,
      enabledExchanges: [...ALL_EXCHANGES]
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
    [{ text: `📊 Режим: ${getModeName(f.mode)}`, callback_data: 'select_mode' }],
    f.mode === 'funding-rate' 
      ? [{ text: `💰 Мин. прибыль: ${f.minFundingProfit}%/день`, callback_data: 'filter_funding_profit' }]
      : [{ text: `📉 Спред: ${f.minSpread}% - ${MAX_SPREAD_PERCENT}%`, callback_data: 'filter_min_spread' }],
    [{ text: `📊 Мин. объём: ${f.minVolume > 0 ? '$' + (f.minVolume/1000).toFixed(0) + 'K' : 'Нет'}`, callback_data: 'filter_min_volume' }],
    [{ text: '💱 Биржи', callback_data: 'filter_exchanges' }],
    [{ text: '🔙 Назад', callback_data: 'back' }]
  ]
});

const getModeKb = (currentMode) => ({
  inline_keyboard: [
    [{ text: `${currentMode === 'spot-futures' ? '✅ ' : ''}📈 Spot-Futures`, callback_data: 'set_mode_spot-futures' }],
    [{ text: `${currentMode === 'futures-futures' ? '✅ ' : ''}🔄 Futures-Futures`, callback_data: 'set_mode_futures-futures' }],
    [{ text: `${currentMode === 'funding-rate' ? '✅ ' : ''}💰 Funding Rate`, callback_data: 'set_mode_funding-rate' }],
    [{ text: `${currentMode === 'fair-price' ? '✅ ' : ''}⚖️ Price vs Fair`, callback_data: 'set_mode_fair-price' }],
    [{ text: `${currentMode === 'triangular' ? '✅ ' : ''}🔺 Triangular Arb`, callback_data: 'set_mode_triangular' }],
    [{ text: '🔙 Назад', callback_data: 'filters' }]
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

const getSpreadKb = () => ({
  inline_keyboard: [
    [0.3, 0.5, 0.7, 1, 1.5].map(v => ({ text: `${v}%`, callback_data: `set_min_spread_${v}` })),
    [2, 3, 5, 7, 10].map(v => ({ text: `${v}%`, callback_data: `set_min_spread_${v}` })),
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
    [100, 250, 500, 750, 1000].map(v => ({ text: `$${v}K`, callback_data: `set_volume_${v}000` })),
    [1500, 2000, 3000, 5000, 10000].map(v => ({ text: `$${v >= 1000 ? (v/1000) + 'M' : v + 'K'}`, callback_data: `set_volume_${v}000` })),
    [{ text: '❌ Без фильтра', callback_data: 'set_volume_0' }],
    [{ text: '🔙 Назад', callback_data: 'filters' }]
  ]
});

function getModeName(mode) {
  return { 
    'spot-futures': '📈 Spot-Futures', 
    'futures-futures': '🔄 Futures-Futures', 
    'funding-rate': '💰 Funding Rate',
    'fair-price': '⚖️ Price vs Fair',
    'triangular': '🔺 Triangular Arb'
  }[mode] || mode;
}

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
      `Я SpreadUP Bot v6.0 для арбитража криптовалют.\n\n` +
      `📊 <b>5 режимов работы:</b>\n` +
      `• 📈 <b>Spot-Futures</b> - спот к фьючерсу\n` +
      `• 🔄 <b>Futures-Futures</b> - между фьючерсами\n` +
      `• 💰 <b>Funding Rate</b> - фандинг арбитраж\n` +
      `• ⚖️ <b>Price vs Fair</b> - отклонение от справедливой цены\n` +
      `• 🔺 <b>Triangular Arb</b> - треугольный арбитраж\n\n` +
      `💱 <b>10 бирж:</b> MEXC, Gate.io, BingX, Bybit, OKX, Bitget, HTX, Lbank, KuCoin, Jupiter\n\n` +
      `🔒 <b>Фильтры:</b> спред ≤${MAX_SPREAD_PERCENT}% | объём ≥$500K\n\n` +
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
      `📖 <b>Справка по SpreadUP Bot v6.0</b>\n\n` +
      `<b>Режимы:</b>\n` +
      `📈 Spot-Futures: спот дешевле → фьючерс дороже\n` +
      `🔄 Futures-Futures: фьючерс A → фьючерс B\n` +
      `💰 Funding Rate: Long низкий / Short высокий\n` +
      `⚖️ Price vs Fair: отклонение от справедливой цены\n` +
      `🔺 Triangular: арбитраж внутри биржи (3 пары)\n\n` +
      `🔒 Макс. спред: ${MAX_SPREAD_PERCENT}%\n` +
      `📊 Мин. объём: $500K\n\n` +
      `<b>Команды:</b>\n/start, /scan, /top, /filters, /status`,
      mainKeyboard
    );
  } else {
    await sendMessage(chatId, 'Команды: /start, /scan, /top, /filters, /status, /help', mainKeyboard);
  }
}

async function handleStatus(chatId) {
  const lastUpdate = priceCache.lastUpdate ? new Date(priceCache.lastUpdate).toLocaleString('ru-RU') : 'Нет данных';
  
  let text = `📊 <b>Статус v6.0</b>\n`;
  text += `🔒 Макс. спред: ${MAX_SPREAD_PERCENT}%\n`;
  text += `📊 Мин. объём: $500K\n\n`;
  text += `📈 Spot-Futures: ${priceCache.opportunities.length}\n`;
  text += `🔄 Futures-Futures: ${priceCache.futuresFuturesOpps.length}\n`;
  text += `💰 Funding Rate: ${priceCache.fundingOpps.length}\n`;
  text += `⚖️ Price vs Fair: ${priceCache.fairPriceOpps.length}\n`;
  text += `🔺 Triangular: ${priceCache.triangularOpps.length}\n\n`;
  
  if (priceCache.exchangeStats && Object.keys(priceCache.exchangeStats).length > 0) {
    text += `📊 <b>Биржи:</b>\n`;
    for (const [ex, stats] of Object.entries(priceCache.exchangeStats)) {
      text += ` ${ex}: ${stats.spot} spot, ${stats.pairs || stats.spot} pairs\n`;
    }
  }
  
  await sendMessage(chatId, text, mainKeyboard);
}

async function handleScan(chatId) {
  await sendMessage(chatId, '🔄 <b>Сканирование...</b>');
  const { spotFuturesOpps, futuresFuturesOpps, fundingOpps, fairPriceOpps, triangularOpps } = await scanAllExchanges();
  const f = getFilters(chatId);
  
  if (f.mode === 'spot-futures') await showSpotFuturesResults(chatId, spotFuturesOpps, f);
  else if (f.mode === 'futures-futures') await showFuturesFuturesResults(chatId, futuresFuturesOpps, f);
  else if (f.mode === 'funding-rate') await showFundingRateResults(chatId, fundingOpps, f);
  else if (f.mode === 'fair-price') await showFairPriceResults(chatId, fairPriceOpps, f);
  else await showTriangularResults(chatId, triangularOpps, f);
}

async function showSpotFuturesResults(chatId, opportunities, f) {
  const filtered = opportunities.filter(opp => {
    if (opp.spreadPercent < f.minSpread) return false;
    if (f.minVolume > 0 && opp.volume24h < f.minVolume) return false;
    if (!f.enabledExchanges.includes(opp.spotExchange)) return false;
    if (!f.enabledExchanges.includes(opp.futuresExchange)) return false;
    return true;
  });
  
  if (filtered.length === 0) {
    await sendMessage(chatId, `📈 <b>Spot-Futures</b>\nНайдено: ${opportunities.length} | После фильтрации: 0`, mainKeyboard);
    return;
  }
  
  let text = `📈 <b>Spot-Futures</b>\nНайдено: ${opportunities.length} | Фильтр: ${filtered.length}\n\n`;
  
  for (let i = 0; i < Math.min(5, filtered.length); i++) {
    const opp = filtered[i];
    const emoji = opp.spreadPercent >= 3 ? '🔥' : opp.spreadPercent >= 1 ? '⚡' : '📊';
    text += `${i+1}. ${emoji} <b>${opp.baseAsset}</b>: ${opp.spreadPercent.toFixed(2)}%\n`;
    text += `   ${opp.spotExchange} ($${formatPrice(opp.spotPrice)}) → ${opp.futuresExchange} ($${formatPrice(opp.futuresPrice)})\n\n`;
  }
  
  await sendMessage(chatId, text, mainKeyboard);
}

async function showFuturesFuturesResults(chatId, opportunities, f) {
  const filtered = opportunities.filter(opp => {
    if (opp.spreadPercent < f.minSpread) return false;
    if (f.minVolume > 0 && opp.volume24h < f.minVolume) return false;
    if (!f.enabledExchanges.includes(opp.buyExchange)) return false;
    if (!f.enabledExchanges.includes(opp.sellExchange)) return false;
    return true;
  });
  
  if (filtered.length === 0) {
    await sendMessage(chatId, `🔄 <b>Futures-Futures</b>\nНайдено: ${opportunities.length} | После фильтрации: 0`, mainKeyboard);
    return;
  }
  
  let text = `🔄 <b>Futures-Futures</b>\nНайдено: ${opportunities.length} | Фильтр: ${filtered.length}\n\n`;
  
  for (let i = 0; i < Math.min(6, filtered.length); i++) {
    const opp = filtered[i];
    const emoji = opp.spreadPercent >= 1 ? '🔥' : opp.spreadPercent >= 0.5 ? '⚡' : '📊';
    text += `${i+1}. ${emoji} <b>${opp.baseAsset}</b>: ${opp.spreadPercent.toFixed(3)}%\n`;
    text += `   📥 ${opp.buyExchange}: $${formatPrice(opp.lowPrice)}\n`;
    text += `   📤 ${opp.sellExchange}: $${formatPrice(opp.highPrice)}\n\n`;
  }
  
  await sendMessage(chatId, text, mainKeyboard);
}

async function showFundingRateResults(chatId, opportunities, f) {
  const filtered = opportunities.filter(opp => {
    if (opp.dailyProfitPercent < f.minFundingProfit) return false;
    if (f.minVolume > 0 && opp.volume24h < f.minVolume) return false;
    if (!f.enabledExchanges.includes(opp.longExchange)) return false;
    if (!f.enabledExchanges.includes(opp.shortExchange)) return false;
    return true;
  });
  
  if (filtered.length === 0) {
    await sendMessage(chatId, `💰 <b>Funding Rate</b>\nНайдено: ${opportunities.length} | После фильтрации: 0`, mainKeyboard);
    return;
  }
  
  let text = `💰 <b>Funding Rate</b>\nНайдено: ${opportunities.length} | Фильтр: ${filtered.length}\n\n`;
  
  for (let i = 0; i < Math.min(8, filtered.length); i++) {
    const opp = filtered[i];
    const emoji = opp.dailyProfitPercent >= 1 ? '🔥' : opp.dailyProfitPercent >= 0.5 ? '⚡' : '📊';
    text += `${i+1}. ${emoji} <b>${opp.baseAsset}</b>: +${opp.dailyProfitPercent.toFixed(2)}%/день\n`;
    text += `   📈 ${opp.longExchange} (${(opp.longRate * 100).toFixed(4)}%)\n`;
    text += `   📉 ${opp.shortExchange} (${(opp.shortRate * 100).toFixed(4)}%)\n\n`;
  }
  
  await sendMessage(chatId, text, mainKeyboard);
}

async function showFairPriceResults(chatId, opportunities, f) {
  const filtered = opportunities.filter(opp => {
    if (opp.spreadPercent < f.minSpread) return false;
    if (f.minVolume > 0 && opp.volume24h < f.minVolume) return false;
    if (!f.enabledExchanges.includes(opp.undervaluedExchange)) return false;
    if (!f.enabledExchanges.includes(opp.overvaluedExchange)) return false;
    return true;
  });
  
  if (filtered.length === 0) {
    await sendMessage(chatId, `⚖️ <b>Price vs Fair</b>\nНайдено: ${opportunities.length} | После фильтрации: 0`, mainKeyboard);
    return;
  }
  
  let text = `⚖️ <b>Price vs Fair Price</b>\nНайдено: ${opportunities.length} | Фильтр: ${filtered.length}\n\n`;
  
  for (let i = 0; i < Math.min(6, filtered.length); i++) {
    const opp = filtered[i];
    const emoji = opp.spreadPercent >= 3 ? '🔥' : opp.spreadPercent >= 1 ? '⚡' : '📊';
    text += `${i+1}. ${emoji} <b>${opp.baseAsset}</b>: ${opp.spreadPercent.toFixed(2)}%\n`;
    text += `   💵 Fair: $${formatPrice(opp.fairPrice)}\n`;
    text += `   🟢 ${opp.undervaluedExchange}: ${opp.undervaluedDeviation.toFixed(2)}%\n`;
    text += `   🔴 ${opp.overvaluedExchange}: +${opp.overvaluedDeviation.toFixed(2)}%\n\n`;
  }
  
  await sendMessage(chatId, text, mainKeyboard);
}

async function showTriangularResults(chatId, opportunities, f) {
  // Filter by enabled exchanges
  const filtered = opportunities.filter(opp => {
    if (opp.profitPercent < f.minSpread) return false;
    if (f.minVolume > 0 && opp.volume24h < f.minVolume) return false;
    if (!f.enabledExchanges.includes(opp.exchange)) return false;
    // Additional check: all pairs must have minimum liquidity
    // pair1 and pair3 are USDT pairs (need 500K), pair2 is cross-pair (need 50K)
    if (opp.pair1Volume < MIN_TRIANGLE_LIQUIDITY) return false;
    if (opp.pair2Volume < 50000) return false;  // Cross-pair needs less
    if (opp.pair3Volume < MIN_TRIANGLE_LIQUIDITY) return false;
    return true;
  });
  
  if (filtered.length === 0) {
    await sendMessage(chatId, `🔺 <b>Triangular Arbitrage</b>\nНайдено: ${opportunities.length} | После фильтрации: 0\n\n💡 Мин. объём каждой пары: $500K`, mainKeyboard);
    return;
  }
  
  let text = `🔺 <b>Triangular Arbitrage</b>\nНайдено: ${opportunities.length} | Фильтр: ${filtered.length}\n\n`;
  
  for (let i = 0; i < Math.min(8, filtered.length); i++) {
    const opp = filtered[i];
    const emoji = opp.profitPercent >= 2 ? '🔥' : opp.profitPercent >= 1 ? '⚡' : '📊';
    text += `${i+1}. ${emoji} <b>${opp.path}</b>\n`;
    text += `   💱 ${opp.exchange}: +${opp.profitPercent.toFixed(2)}%\n`;
    text += `   💵 $${opp.startAmount.toFixed(0)} → $${opp.endAmount.toFixed(2)}\n`;
    text += `   📊 Объём: $${(opp.pair1Volume/1000).toFixed(0)}K / $${(opp.pair2Volume/1000).toFixed(0)}K / $${(opp.pair3Volume/1000).toFixed(0)}K\n\n`;
  }
  
  await sendMessage(chatId, text, mainKeyboard);
}

async function handleTop(chatId) {
  const f = getFilters(chatId);
  if (priceCache.lastUpdate === null) {
    await sendMessage(chatId, '📊 Нет данных. /scan', mainKeyboard);
    return;
  }
  if (f.mode === 'spot-futures') await showSpotFuturesResults(chatId, priceCache.opportunities, f);
  else if (f.mode === 'futures-futures') await showFuturesFuturesResults(chatId, priceCache.futuresFuturesOpps, f);
  else if (f.mode === 'funding-rate') await showFundingRateResults(chatId, priceCache.fundingOpps, f);
  else if (f.mode === 'fair-price') await showFairPriceResults(chatId, priceCache.fairPriceOpps, f);
  else await showTriangularResults(chatId, priceCache.triangularOpps, f);
}

async function handleCallback(cb) {
  const chatId = cb.message?.chat?.id;
  const data = cb.data;
  const f = getFilters(chatId);
  
  await answerCallback(cb.id);

  if (data === 'back') await sendMessage(chatId, '🏠 Меню', mainKeyboard);
  else if (data === 'subscribe') { userSubscribed[chatId] = true; await sendMessage(chatId, '✅ Подписка оформлена', mainKeyboard); }
  else if (data === 'unsubscribe') { userSubscribed[chatId] = false; await sendMessage(chatId, '🔕 Подписка отменена', mainKeyboard); }
  else if (data === 'status') await handleStatus(chatId);
  else if (data === 'filters') await sendMessage(chatId, '⚙️ Фильтры', getFiltersKb(f));
  else if (data === 'scan') await handleScan(chatId);
  else if (data === 'top') await handleTop(chatId);
  else if (data === 'select_mode') await sendMessage(chatId, '📊 <b>Режим:</b>', getModeKb(f.mode));
  else if (data === 'set_mode_spot-futures') { f.mode = 'spot-futures'; await sendMessage(chatId, '✅ Spot-Futures', getFiltersKb(f)); }
  else if (data === 'set_mode_futures-futures') { f.mode = 'futures-futures'; await sendMessage(chatId, '✅ Futures-Futures', getFiltersKb(f)); }
  else if (data === 'set_mode_funding-rate') { f.mode = 'funding-rate'; await sendMessage(chatId, '✅ Funding Rate', getFiltersKb(f)); }
  else if (data === 'set_mode_fair-price') { f.mode = 'fair-price'; await sendMessage(chatId, '✅ Price vs Fair', getFiltersKb(f)); }
  else if (data === 'set_mode_triangular') { f.mode = 'triangular'; await sendMessage(chatId, '✅ Triangular Arbitrage', getFiltersKb(f)); }
  else if (data === 'filter_min_spread') await sendMessage(chatId, '📉 <b>Мин. спред</b>', getSpreadKb());
  else if (data === 'filter_funding_profit') await sendMessage(chatId, '💰 <b>Мин. прибыль</b>', getFundingProfitKb());
  else if (data === 'filter_min_volume') await sendMessage(chatId, '📊 <b>Мин. объём (USDT)</b>', getVolumeKb());
  else if (data === 'filter_exchanges') await sendMessage(chatId, '💱 <b>Биржи</b>', getExchangesKb(f.enabledExchanges));
  else if (data.startsWith('set_min_spread_')) { f.minSpread = parseFloat(data.replace('set_min_spread_', '')); await sendMessage(chatId, `📉 Спред: ${f.minSpread}%`, getFiltersKb(f)); }
  else if (data.startsWith('set_funding_profit_')) { f.minFundingProfit = parseFloat(data.replace('set_funding_profit_', '')); await sendMessage(chatId, `💰 Прибыль: ${f.minFundingProfit}%/день`, getFiltersKb(f)); }
  else if (data.startsWith('set_volume_')) { 
    f.minVolume = parseInt(data.replace('set_volume_', '')); 
    const volText = f.minVolume > 0 ? `$${(f.minVolume/1000).toFixed(0)}K` : 'Нет';
    await sendMessage(chatId, `📊 Объём: ${volText}`, getFiltersKb(f)); 
  }
  else if (data.startsWith('toggle_exchange_')) {
    const exchange = data.replace('toggle_exchange_', '').replace('Gateio', 'Gate.io');
    const idx = f.enabledExchanges.indexOf(exchange);
    if (idx >= 0) f.enabledExchanges.splice(idx, 1);
    else f.enabledExchanges.push(exchange);
    await sendMessage(chatId, '💱 Обновлено', getExchangesKb(f.enabledExchanges));
  } else if (data === 'enable_all') { f.enabledExchanges = [...ALL_EXCHANGES]; await sendMessage(chatId, '✅ Все включены', getExchangesKb(f.enabledExchanges)); }
  else if (data === 'disable_all') { f.enabledExchanges = []; await sendMessage(chatId, '❌ Все отключены', getExchangesKb(f.enabledExchanges)); }
}

// ========== Alerts ==========

async function sendAlerts(spotFuturesOpps, futuresFuturesOpps, fundingOpps) {
  const subscribers = Object.keys(userSubscribed).filter(id => userSubscribed[id]);
  if (subscribers.length === 0) return;
  
  const now = Date.now();
  const cooldownMs = 20 * 60 * 1000;
  
  for (const opp of spotFuturesOpps) {
    if (opp.spreadPercent < 2 || opp.spreadPercent > MAX_SPREAD_PERCENT) continue;
    if (opp.volume24h < 500000) continue;
    const assetKey = `sf_${opp.baseAsset}`;
    if (lastAlertTime[assetKey] && (now - lastAlertTime[assetKey]) < cooldownMs) continue;
    
    const msg = `🔥 <b>SPOT-FUTURES</b>\n${opp.baseAsset}: ${opp.spreadPercent.toFixed(2)}%\n${opp.spotExchange} → ${opp.futuresExchange}`;
    for (const chatId of subscribers) {
      const filters = getFilters(chatId);
      if (filters.mode === 'spot-futures' && opp.spreadPercent >= filters.minSpread) {
        if (filters.minVolume > 0 && opp.volume24h < filters.minVolume) continue;
        try { await sendMessage(chatId, msg); } catch (e) {}
      }
    }
    lastAlertTime[assetKey] = now;
  }
  
  for (const opp of futuresFuturesOpps) {
    if (opp.spreadPercent < 0.5 || opp.spreadPercent > MAX_SPREAD_PERCENT) continue;
    if (opp.volume24h < 500000) continue;
    const assetKey = `ff_${opp.baseAsset}`;
    if (lastAlertTime[assetKey] && (now - lastAlertTime[assetKey]) < cooldownMs) continue;
    
    const msg = `🔄 <b>FUTURES-FUTURES</b>\n${opp.baseAsset}: ${opp.spreadPercent.toFixed(3)}%\n${opp.buyExchange} → ${opp.sellExchange}`;
    for (const chatId of subscribers) {
      const filters = getFilters(chatId);
      if (filters.mode === 'futures-futures' && opp.spreadPercent >= filters.minSpread) {
        if (filters.minVolume > 0 && opp.volume24h < filters.minVolume) continue;
        try { await sendMessage(chatId, msg); } catch (e) {}
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

// ========== Main Handler ==========

export default async function handler(req, res) {
  if (req.method === 'GET') {
    const { cron } = req.query;
    
    if (cron === 'scan') {
      try {
        const { spotFuturesOpps, futuresFuturesOpps, fundingOpps, fairPriceOpps, triangularOpps } = await scanAllExchanges();
        await sendAlerts(spotFuturesOpps, futuresFuturesOpps, fundingOpps);
        return res.status(200).json({ 
          status: 'scanned',
          spotFutures: spotFuturesOpps.length,
          futuresFutures: futuresFuturesOpps.length,
          fundingRate: fundingOpps.length,
          fairPrice: fairPriceOpps.length,
          triangular: triangularOpps.length,
          maxSpread: MAX_SPREAD_PERCENT,
          minVolume: 500000,
          exchangeStats: priceCache.exchangeStats,
          timestamp: new Date().toISOString()
        });
      } catch (e) {
        return res.status(500).json({ error: e.message });
      }
    }
    
    return res.status(200).json({
      status: 'SpreadUP Bot Active',
      version: '6.0.0',
      modes: ['spot-futures', 'futures-futures', 'funding-rate', 'fair-price', 'triangular'],
      exchanges: ALL_EXCHANGES,
      maxSpread: MAX_SPREAD_PERCENT,
      minVolume: 500000,
      spotFuturesOpps: priceCache.opportunities.length,
      futuresFuturesOpps: priceCache.futuresFuturesOpps.length,
      fundingOpps: priceCache.fundingOpps.length,
      fairPriceOpps: priceCache.fairPriceOpps.length,
      triangularOpps: priceCache.triangularOpps.length,
      exchangeStats: priceCache.exchangeStats
    });
  }

  try {
    if (req.body.message) await handleMessage(req.body.message);
    if (req.body.callback_query) await handleCallback(req.body.callback_query);
    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(200).json({ ok: true, error: e.message });
  }
}
