/**
 * SpreadUP Bot v10.1 - Multi-Mode Arbitrage Scanner
 * 
 * Modes:
 * 1. Spot-Futures - Spot to Futures arbitrage
 * 2. Futures-Futures - Cross-exchange futures arbitrage
 * 3. Funding Rate - Funding rate arbitrage
 * 4. Price vs Fair Price - Deviation from weighted average price
 * 5. Triangular Arbitrage - Intra-exchange triangle arb (USDT -> BTC -> ETH -> USDT)
 *    v10.1: Added 4 DEX exchanges (Uniswap, PancakeSwap, Raydium, Orca)
 * 
 * Exchanges: 14 total
 * - CEX: MEXC, Gate.io, BingX, Bybit, OKX, Bitget, HTX, Lbank, KuCoin, Jupiter
 * - DEX: Uniswap, PancakeSwap, Raydium, Orca
 * 
 * Filters:
 * - Max spread 20% to filter out junk/scam tokens
 * - Min volume 500K USDT for USDT pairs
 * - Min volume 10K for cross-pairs (to filter dead pairs)
 * - Triangular: profit after fees
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

// All supported exchanges (14 total - 9 CEX + 5 DEX)
const ALL_EXCHANGES = ['MEXC', 'Gate.io', 'BingX', 'Bybit', 'OKX', 'Bitget', 'HTX', 'Lbank', 'KuCoin', 'Jupiter', 'Uniswap', 'PancakeSwap', 'Raydium', 'Orca'];
const FUTURES_EXCHANGES = ['MEXC', 'Gate.io', 'BingX', 'Bybit', 'OKX', 'Bitget'];

// Exchanges that support triangular arbitrage (have many pairs)
// DEX exchanges work on specific chains - triangles must stay within same chain
const TRIANGLE_EXCHANGES = ['MEXC', 'Gate.io', 'OKX', 'Bybit', 'Bitget', 'KuCoin', 'Raydium', 'Orca', 'Uniswap', 'PancakeSwap'];

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
    
    console.log(`MEXC: ${Object.keys(spot).length} spot, ${Object.keys(allPairs).length} allPairs`);
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
    
    console.log(`Gate.io: ${Object.keys(spot).length} spot, ${Object.keys(allPairs).length} allPairs`);
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
          // vol is base currency amount, need to multiply by price for USDT volume
          const baseVol = parseFloat(data.tick.vol) || 0;
          const vol = baseVol * price; // Convert to quote currency (USDT)
          
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
            // Lbank doesn't provide volume in this endpoint, skip for volume filtering
            // volumes[symbol] = 0; // Don't add - will use max from other exchanges
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

// ========== DEX Exchange Fetchers ==========

// Popular token addresses for different chains
const DEX_TOKENS = {
  // Solana tokens (for Raydium, Orca)
  solana: [
    { symbol: 'SOL', address: 'So11111111111111111111111111111111111111112' },
    { symbol: 'BONK', address: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263' },
    { symbol: 'WIF', address: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm' },
    { symbol: 'JUP', address: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN' },
    { symbol: 'RAY', address: '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R' },
    { symbol: 'ORCA', address: 'orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE' },
    { symbol: 'RENDER', address: 'rndrizKT3MK1iimdxRmWzYBfFW6E3kVvkdZ1uWgjThq' },
    { symbol: 'POPCAT', address: '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr' },
    { symbol: 'PYTH', address: 'HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3' },
    { symbol: 'JITO', address: 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn' }
  ],
  // Ethereum tokens (for Uniswap)
  ethereum: [
    { symbol: 'ETH', address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' },
    { symbol: 'WBTC', address: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599' },
    { symbol: 'USDC', address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' },
    { symbol: 'LINK', address: '0x514910771AF9Ca656af840dff83E8264EcF986CA' },
    { symbol: 'UNI', address: '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984' },
    { symbol: 'AAVE', address: '0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9' },
    { symbol: 'PEPE', address: '0x6982508145454Ce325dDbE47a25d4ec3d2311933' },
    { symbol: 'SHIB', address: '0x95aD61b0a150d79219dCF64E1E6Cc01f0B64C4cE' }
  ],
  // BSC tokens (for PancakeSwap)
  bsc: [
    { symbol: 'BNB', address: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c' },
    { symbol: 'CAKE', address: '0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82' },
    { symbol: 'BUSD', address: '0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56' },
    { symbol: 'ETH', address: '0x2170Ed0880ac9A755fd29B2688956BD959F933F8' },
    { symbol: 'BTCB', address: '0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c' }
  ]
};

// Generic DEX fetcher using Dexscreener API
async function fetchDEXPrices(dexName, chainId, tokens) {
  const spot = {}, volumes = {}, allPairs = {};
  
  try {
    const fetchPromises = tokens.map(async (token) => {
      try {
        const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${token.address}`, {
          signal: AbortSignal.timeout(15000)
        });
        const data = await res.json();
        
        if (data.pairs && data.pairs.length > 0) {
          const bestPair = data.pairs
            .filter(p => {
              if (p.chainId !== chainId) return false;
              const quote = p.quoteToken?.symbol;
              return (quote === 'USDC' || quote === 'USDT' || quote === 'WETH' || quote === 'ETH' || quote === 'WBNB' || quote === 'BNB') && 
                     (p.liquidity?.usd || 0) > 50000;
            })
            .sort((a, b) => (parseFloat(b.liquidity?.usd || 0)) - (parseFloat(a.liquidity?.usd || 0)))[0];
          
          if (bestPair && bestPair.priceUsd) {
            const price = parseFloat(bestPair.priceUsd);
            const vol = parseFloat(bestPair.volume?.h24 || 0);
            if (price > 0 && vol > 0) {
              const quoteSymbol = bestPair.quoteToken?.symbol === 'WETH' ? 'ETH' : 
                                  bestPair.quoteToken?.symbol === 'WBNB' ? 'BNB' : 
                                  bestPair.quoteToken?.symbol;
              
              return {
                symbol: token.symbol + 'USDT',
                price,
                volume: vol,
                crossPair: token.symbol + quoteSymbol,
                crossPrice: parseFloat(bestPair.priceNative) || price,
                crossVolume: vol
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
        allPairs[result.symbol] = { price: result.price, volume: result.volume };
        
        if (result.crossPair && result.crossPair !== result.symbol) {
          allPairs[result.crossPair] = { price: result.crossPrice, volume: result.crossVolume };
        }
      }
    }
    
    if (chainId === 'ethereum' || chainId === 'solana') {
      allPairs['USDCUSDT'] = { price: 1.0, volume: 10000000 };
    }
    
    console.log(`${dexName}: ${Object.keys(spot).length} spot, ${Object.keys(allPairs).length} pairs`);
    return { spot, futures: {}, volumes, funding: {}, allPairs, exchange: dexName };
  } catch (e) {
    console.error(`${dexName} error:`, e.message);
    return { spot: {}, futures: {}, volumes: {}, funding: {}, allPairs: {}, exchange: dexName };
  }
}

// Raydium (Solana DEX)
async function fetchRaydiumPrices() {
  return fetchDEXPrices('Raydium', 'solana', DEX_TOKENS.solana);
}

// Orca (Solana DEX)
async function fetchOrcaPrices() {
  return fetchDEXPrices('Orca', 'solana', DEX_TOKENS.solana);
}

// Uniswap (Ethereum DEX)
async function fetchUniswapPrices() {
  return fetchDEXPrices('Uniswap', 'ethereum', DEX_TOKENS.ethereum);
}

// PancakeSwap (BSC DEX)
async function fetchPancakeSwapPrices() {
  return fetchDEXPrices('PancakeSwap', 'bsc', DEX_TOKENS.bsc);
}

// ========== Triangular Arbitrage Calculation ==========

// Trading fees per exchange (taker fee for market orders)
const EXCHANGE_FEES = {
  // CEX fees
  'MEXC': 0.002,      // 0.2%
  'Gate.io': 0.002,   // 0.2%
  'Bybit': 0.001,     // 0.1%
  'OKX': 0.001,       // 0.1%
  'Bitget': 0.001,    // 0.1%
  'KuCoin': 0.001,    // 0.1%
  'BingX': 0.001,     // 0.1%
  'HTX': 0.002,       // 0.2%
  'Lbank': 0.002,     // 0.2%
  // DEX fees (swap fees + gas estimated)
  'Jupiter': 0.0003,     // 0.03% (Solana DEX aggregator)
  'Raydium': 0.0025,     // 0.25% (Solana DEX)
  'Orca': 0.002,         // 0.2% (Solana DEX)
  'Uniswap': 0.003,      // 0.3% (Ethereum DEX + gas)
  'PancakeSwap': 0.0025  // 0.25% (BSC DEX)
};

// Expanded list of intermediate assets for triangular arbitrage
const MID_ASSETS = [
  // Tier 1: Highest liquidity - Main trading pairs
  'BTC', 'ETH', 'SOL', 'BNB', 'XRP',
  // Tier 2: Stablecoins for cross-pair arbitrage
  'USDC', 'DAI', 'TUSD',
  // Tier 3: High-cap alts with good cross-pairs
  'DOGE', 'ADA', 'AVAX', 'MATIC', 'LINK',
  'DOT', 'UNI', 'ATOM', 'LTC', 'NEAR',
  'ARB', 'OP', 'APT', 'SUI', 'INJ',
  'FIL', 'AAVE', 'RUNE', 'FTM', 'ICP'
];

// Starting currencies for triangles
const START_CURRENCIES = ['USDT', 'USDC'];

function findTriangularOpportunities(allPairs, exchange) {
  const opportunities = [];
  const pairs = Object.keys(allPairs);
  
  // Get exchange fee (3 trades in triangle)
  const feePerTrade = EXCHANGE_FEES[exchange] || 0.002;
  const totalFees = feePerTrade * 3; // Total fees for 3 trades
  
  // Build pair lookup for fast access
  const pairMap = {};
  for (const pair of pairs) {
    pairMap[pair] = allPairs[pair];
  }
  
  // Helper function to get pair price and volume
  function getPairInfo(base, quote) {
    // Try both orderings: BASEQUOTE and QUOTEBASE
    const pair1 = base + quote;
    const pair2 = quote + base;
    
    if (pairMap[pair1]) {
      return {
        price: pairMap[pair1].price,
        volume: pairMap[pair1].volume || 0,
        pair: pair1,
        inverted: false
      };
    }
    if (pairMap[pair2]) {
      return {
        price: 1 / pairMap[pair2].price, // Invert price
        volume: pairMap[pair2].volume || 0,
        pair: pair2,
        inverted: true
      };
    }
    return null;
  }
  
  // ===== MAIN TRIANGLE LOGIC =====
  // For each start currency (USDT, USDC)
  for (const startCurrency of START_CURRENCIES) {
    // For each intermediate asset
    for (const midAsset of MID_ASSETS) {
      if (midAsset === startCurrency) continue;
      
      // Skip if not in whitelist
      if (!LIQUID_ASSETS.has(midAsset)) continue;
      
      // Step 1: Get pair startCurrency/midAsset
      const step1 = getPairInfo(midAsset, startCurrency);
      if (!step1) continue;
      
      // Check volume for startCurrency pair
      if (step1.volume < MIN_TRIANGLE_LIQUIDITY) continue;
      
      // Price to buy midAsset with startCurrency
      const midPriceInStart = step1.price;
      
      // Find all pairs with midAsset to form step 2
      for (const pair of pairs) {
        let finalAsset = null;
        let step2Price = 0;
        let step2Volume = 0;
        let step2Pair = null;
        
        // Parse the pair to find the other asset
        if (pair.startsWith(midAsset) && pair !== step1.pair) {
          finalAsset = pair.replace(midAsset, '');
        } else if (pair.endsWith(midAsset) && pair !== step1.pair) {
          finalAsset = pair.replace(midAsset, '');
        }
        
        // Validate finalAsset
        if (!finalAsset || finalAsset === startCurrency || finalAsset === midAsset) continue;
        if (finalAsset.length < 2 || finalAsset.length > 10) continue;
        if (!LIQUID_ASSETS.has(finalAsset)) continue;
        
        // Get step 2 info (midAsset -> finalAsset)
        // We need: "how much finalAsset for 1 midAsset" = getPairInfo(midAsset, finalAsset)
        const step2 = getPairInfo(midAsset, finalAsset);
        if (!step2) continue;
        step2Price = step2.price;
        step2Volume = step2.volume;
        step2Pair = step2.pair;
        
        // Check volume for cross-pair (must have SOME trading activity)
        // Cross-pairs naturally have lower volume, but > 0 is required
        // Minimum 10K USDT equivalent to filter dead pairs
        const MIN_CROSS_PAIR_VOLUME = 10000; // $10K minimum for cross-pairs
        if (step2Volume < MIN_CROSS_PAIR_VOLUME) continue;
        
        // Step 3: Get pair finalAsset/startCurrency
        const step3 = getPairInfo(finalAsset, startCurrency);
        if (!step3) continue;
        
        // Check volume for final/startCurrency pair
        if (step3.volume < MIN_TRIANGLE_LIQUIDITY) continue;
        
        const finalPriceInStart = step3.price;
        
        // ===== CALCULATE PROFIT =====
        const startAmount = 1000; // $1000 starting
        
        // Step 1: Buy midAsset with startCurrency (apply fee)
        const midAmount = (startAmount / midPriceInStart) * (1 - feePerTrade);
        
        // Step 2: Trade midAsset for finalAsset (apply fee)
        const finalAmount = (midAmount * step2Price) * (1 - feePerTrade);
        
        // Step 3: Sell finalAsset for startCurrency (apply fee)
        const endAmount = (finalAmount * finalPriceInStart) * (1 - feePerTrade);
        
        // Calculate profits
        const grossProfitPercent = ((endAmount - startAmount) / startAmount) * 100;
        const netProfitPercent = grossProfitPercent; // Fees already applied above
        const feesPercent = totalFees * 100;
        
        // Filter: profit after fees > 0.05%, within max spread
        if (netProfitPercent > 0.05 && netProfitPercent <= MAX_SPREAD_PERCENT) {
          // Avoid duplicates
          const pathKey = `${startCurrency}-${midAsset}-${finalAsset}-${startCurrency}`;
          
          opportunities.push({
            type: 'triangular',
            exchange,
            startCurrency,
            path: `${startCurrency} → ${midAsset} → ${finalAsset} → ${startCurrency}`,
            midAsset,
            finalAsset,
            startAmount,
            endAmount,
            profitPercent: netProfitPercent,
            grossProfitPercent,
            feesPercent,
            totalFees: totalFees * 100,
            pair1Volume: step1.volume,
            pair2Volume: step2Volume,
            pair3Volume: step3.volume,
            volume24h: Math.min(step1.volume, step3.volume), // Min of USDT pairs
            steps: [
              { pair: step1.pair, action: 'buy', asset: midAsset, price: midPriceInStart, volume: step1.volume },
              { pair: step2Pair, action: 'trade', asset: finalAsset, price: step2Price, volume: step2Volume },
              { pair: step3.pair, action: 'sell', asset: startCurrency, price: finalPriceInStart, volume: step3.volume }
            ]
          });
        }
        
        // ===== REVERSE PATH =====
        // Try reverse: startCurrency -> finalAsset -> midAsset -> startCurrency
        // Example: USDT -> USDC -> SUI -> USDT
        const revStep1 = getPairInfo(finalAsset, startCurrency);
        if (!revStep1 || revStep1.volume < MIN_TRIANGLE_LIQUIDITY) continue;
        
        // We need: "how much midAsset for 1 finalAsset" = getPairInfo(finalAsset, midAsset)
        const revStep2 = getPairInfo(finalAsset, midAsset);
        if (!revStep2) continue;
        
        // Check volume for cross-pair (same as main path)
        if (revStep2.volume < MIN_CROSS_PAIR_VOLUME) continue;
        
        const revStep3 = getPairInfo(midAsset, startCurrency);
        if (!revStep3 || revStep3.volume < MIN_TRIANGLE_LIQUIDITY) continue;
        
        // Calculate reverse profit
        const revStartAmount = 1000;
        const revMidAmount = (revStartAmount / revStep1.price) * (1 - feePerTrade);
        const revFinalAmount = (revMidAmount * revStep2.price) * (1 - feePerTrade);
        const revEndAmount = (revFinalAmount * revStep3.price) * (1 - feePerTrade);
        
        const revProfitPercent = ((revEndAmount - revStartAmount) / revStartAmount) * 100;
        
        if (revProfitPercent > 0.05 && revProfitPercent <= MAX_SPREAD_PERCENT) {
          opportunities.push({
            type: 'triangular',
            exchange,
            startCurrency,
            path: `${startCurrency} → ${finalAsset} → ${midAsset} → ${startCurrency}`,
            midAsset: finalAsset,
            finalAsset: midAsset,
            startAmount: revStartAmount,
            endAmount: revEndAmount,
            profitPercent: revProfitPercent,
            grossProfitPercent: revProfitPercent,
            feesPercent,
            totalFees: totalFees * 100,
            pair1Volume: revStep1.volume,
            pair2Volume: revStep2.volume,
            pair3Volume: revStep3.volume,
            volume24h: Math.min(revStep1.volume, revStep3.volume),
            steps: [
              { pair: revStep1.pair, action: 'buy', asset: finalAsset, price: revStep1.price, volume: revStep1.volume },
              { pair: revStep2.pair, action: 'trade', asset: midAsset, price: revStep2.price, volume: revStep2.volume },
              { pair: revStep3.pair, action: 'sell', asset: startCurrency, price: revStep3.price, volume: revStep3.volume }
            ]
          });
        }
      }
    }
  }
  
  // Remove duplicates (same path, different discovery)
  const seen = new Set();
  const uniqueOpps = opportunities.filter(opp => {
    const key = `${opp.exchange}-${opp.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  
  // Sort by net profit (after fees)
  uniqueOpps.sort((a, b) => b.profitPercent - a.profitPercent);
  
  console.log(`[${exchange}] Triangles: ${uniqueOpps.length} found (fees: ${(totalFees*100).toFixed(2)}% x3)`);
  
  return uniqueOpps;
}

// ========== Cross-Exchange Triangular Arbitrage ==========

/**
 * Find cross-exchange triangular arbitrage opportunities.
 * Each step of the triangle uses the BEST price across ALL exchanges.
 * 
 * Example: USDT -> BTC (buy on MEXC) -> ETH (trade on Bybit) -> USDT (sell on OKX)
 * 
 * Prerequisites: User has balances on multiple exchanges
 */
function findCrossExchangeTriangles(allSpot, allVolumes) {
  const opportunities = [];
  const MIN_VOLUME = 500000; // 500K minimum
  
  // Get all exchanges that have prices
  const allExchanges = new Set();
  for (const symbol in allSpot) {
    for (const ex in allSpot[symbol]) {
      allExchanges.add(ex);
    }
  }
  
  // Helper to find best price across exchanges
  function findBestPrice(symbol, direction) {
    const prices = allSpot[symbol];
    if (!prices) return null;
    
    let bestEx = null;
    let bestPrice = direction === 'buy' ? Infinity : -Infinity;
    
    for (const ex in prices) {
      const price = prices[ex];
      const vol = allVolumes[symbol] || MIN_VOLUME;
      
      if (price > 0 && vol >= MIN_VOLUME) {
        if (direction === 'buy' && price < bestPrice) {
          bestPrice = price;
          bestEx = ex;
        } else if (direction === 'sell' && price > bestPrice) {
          bestPrice = price;
          bestEx = ex;
        }
      }
    }
    
    return bestEx ? { exchange: bestEx, price: bestPrice, volume: allVolumes[symbol] || 0 } : null;
  }
  
  // Helper to get price on specific exchange
  function getPriceOnExchange(symbol, exchange) {
    const prices = allSpot[symbol];
    if (!prices || !prices[exchange]) return null;
    return { price: prices[exchange], volume: allVolumes[symbol] || 0 };
  }
  
  // Build triangle paths
  // USDT -> midAsset -> finalAsset -> USDT
  for (const midAsset of MID_ASSETS) {
    if (midAsset === 'USDT' || midAsset === 'USDC') continue;
    
    const pair1 = midAsset + 'USDT'; // Buy midAsset with USDT
    
    // Find best exchange to BUY midAsset (lowest price)
    const buyMidResult = findBestPrice(pair1, 'buy');
    if (!buyMidResult) continue;
    
    // Find all assets that have pairs with midAsset
    for (const finalAsset of MID_ASSETS) {
      if (finalAsset === midAsset || finalAsset === 'USDT' || finalAsset === 'USDC') continue;
      
      // Check cross-pair: midAsset/finalAsset
      const crossPairDirect = midAsset + finalAsset;
      const crossPairInverse = finalAsset + midAsset;
      
      let crossPair = null;
      let crossPrice = 0;
      let crossEx = null;
      let crossDirection = 'direct'; // direct = midAsset/finalAsset, inverse = finalAsset/midAsset
      
      // Try to find cross-pair on any exchange
      for (const ex of allExchanges) {
        const direct = getPriceOnExchange(crossPairDirect, ex);
        const inverse = getPriceOnExchange(crossPairInverse, ex);
        
        if (direct && direct.price > 0) {
          crossPair = crossPairDirect;
          crossPrice = direct.price;
          crossEx = ex;
          crossDirection = 'direct';
          break;
        } else if (inverse && inverse.price > 0) {
          crossPair = crossPairInverse;
          crossPrice = 1 / inverse.price; // Invert
          crossEx = ex;
          crossDirection = 'inverse';
          break;
        }
      }
      
      if (!crossPair || crossPrice <= 0) continue;
      
      const pair3 = finalAsset + 'USDT'; // Sell finalAsset for USDT
      
      // Find best exchange to SELL finalAsset (highest price)
      const sellFinalResult = findBestPrice(pair3, 'sell');
      if (!sellFinalResult) continue;
      
      // Calculate cross-exchange triangle profit
      const startAmount = 1000;
      const fee1 = EXCHANGE_FEES[buyMidResult.exchange] || 0.002;
      const fee2 = EXCHANGE_FEES[crossEx] || 0.002;
      const fee3 = EXCHANGE_FEES[sellFinalResult.exchange] || 0.002;
      const totalFees = fee1 + fee2 + fee3;
      
      // Step 1: Buy midAsset with USDT (on buyMidResult.exchange)
      const midAmount = (startAmount / buyMidResult.price) * (1 - fee1);
      
      // Step 2: Trade midAsset for finalAsset (on crossEx)
      const finalAmount = (midAmount * crossPrice) * (1 - fee2);
      
      // Step 3: Sell finalAsset for USDT (on sellFinalResult.exchange)
      const endAmount = (finalAmount * sellFinalResult.price) * (1 - fee3);
      
      const profitPercent = ((endAmount - startAmount) / startAmount) * 100;
      
      // Filter: profit > 0.05% and realistic
      if (profitPercent > 0.1 && profitPercent <= MAX_SPREAD_PERCENT) {
        opportunities.push({
          type: 'cross-exchange-triangle',
          path: `USDT → ${midAsset} → ${finalAsset} → USDT`,
          midAsset,
          finalAsset,
          startAmount,
          endAmount,
          profitPercent,
          totalFees: totalFees * 100,
          steps: [
            {
              action: 'BUY',
              asset: midAsset,
              pair: pair1,
              exchange: buyMidResult.exchange,
              price: buyMidResult.price,
              volume: buyMidResult.volume
            },
            {
              action: 'TRADE',
              from: midAsset,
              to: finalAsset,
              pair: crossPair,
              exchange: crossEx,
              price: crossPrice,
              direction: crossDirection
            },
            {
              action: 'SELL',
              asset: finalAsset,
              pair: pair3,
              exchange: sellFinalResult.exchange,
              price: sellFinalResult.price,
              volume: sellFinalResult.volume
            }
          ],
          exchanges: [buyMidResult.exchange, crossEx, sellFinalResult.exchange],
          volume24h: Math.min(buyMidResult.volume, sellFinalResult.volume)
        });
      }
    }
  }
  
  // Remove duplicates and sort
  const seen = new Set();
  const uniqueOpps = opportunities.filter(opp => {
    const key = opp.path + '|' + opp.exchanges.sort().join(',');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  
  uniqueOpps.sort((a, b) => b.profitPercent - a.profitPercent);
  
  console.log(`Cross-Exchange Triangles: ${uniqueOpps.length} found`);
  
  return uniqueOpps.slice(0, 50); // Top 50
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
    fetchJupiterPrices(),
    // New DEX fetchers
    fetchRaydiumPrices(),
    fetchOrcaPrices(),
    fetchUniswapPrices(),
    fetchPancakeSwapPrices()
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
  
  for (const exchange of TRIANGLE_EXCHANGES) {
    const pairs = allExchangePairs[exchange];
    if (pairs) {
      const triangles = findTriangularOpportunities(pairs, exchange);
      triangularOpps.push(...triangles);
    }
  }
  
  // Sort by profit and take top opportunities
  triangularOpps.sort((a, b) => b.profitPercent - a.profitPercent);
  
  // === 6. Cross-Exchange Triangular Arbitrage ===
  // Find triangles where each step uses the best price across all exchanges
  const crossExchangeOpps = findCrossExchangeTriangles(allSpot, allVolumes);
  
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
  priceCache.crossExchangeOpps = crossExchangeOpps;
  priceCache.exchangeStats = exchangeStats;
  priceCache.lastUpdate = new Date();
  
  console.log(`Found: ${spotFuturesOpps.length} spot-futures, ${futuresFuturesOpps.length} futures-futures, ${fundingOpps.length} funding, ${fairPriceOpps.length} fair-price, ${triangularOpps.length} triangular`);
  
  return { spotFuturesOpps, futuresFuturesOpps, fundingOpps, fairPriceOpps, triangularOpps, exchangeStats };
}

function getUrl(exchange, symbol, type) {
  const base = symbol.replace('USDT', '').replace('USDC', '');
  const isSpot = type === 'spot';
  
  const urls = {
    // CEX
    'MEXC': isSpot ? `https://www.mexc.com/exchange/${symbol}` : `https://www.mexc.com/futures/${base}USDT`,
    'Gate.io': isSpot ? `https://www.gate.io/trade/${base}_USDT` : `https://www.gate.io/futures_trade/USDT/${base}_USDT`,
    'BingX': isSpot ? `https://bingx.com/en-us/spot/${base}-USDT` : `https://bingx.com/en-us/futures/${base}-USDT`,
    'Bybit': isSpot ? `https://www.bybit.com/trade/spot/${symbol}` : `https://www.bybit.com/trade/usdt/${symbol}`,
    'OKX': isSpot ? `https://www.okx.com/trade-spot/${base}-USDT` : `https://www.okx.com/trade-swap/${base}-USDT-SWAP`,
    'Bitget': isSpot ? `https://www.bitget.com/spot/${symbol}` : `https://www.bitget.com/futures/usdt/${symbol}`,
    'HTX': `https://www.htx.com/trade/${base}-usdt`,
    'Lbank': `https://www.lbank.com/trade/${base}_usdt`,
    'KuCoin': `https://www.kucoin.com/trade/${base}-USDT`,
    // DEX - Solana
    'Jupiter': `https://jup.ag/swap/${base}-USDC`,
    'Raydium': `https://raydium.io/swap/?inputMint=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&outputMint=${base}`,
    'Orca': `https://www.orca.so/?tokenIn=USDC&tokenOut=${base}`,
    // DEX - Ethereum
    'Uniswap': `https://app.uniswap.org/#/swap?outputCurrency=${base}`,
    // DEX - BSC
    'PancakeSwap': `https://pancakeswap.finance/swap?outputCurrency=${base}`
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
    [{ text: `${currentMode === 'cross-exchange' ? '✅ ' : ''}🌐 Cross-Exchange Triangle`, callback_data: 'set_mode_cross-exchange' }],
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
      `Я SpreadUP Bot v10.1 для арбитража криптовалют.\n\n` +
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
      `📖 <b>Справка по SpreadUP Bot v10.1</b>\n\n` +
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
  
  let text = `📊 <b>Статус v10.1</b>\n`;
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
  const { spotFuturesOpps, futuresFuturesOpps, fundingOpps, fairPriceOpps, triangularOpps, crossExchangeOpps } = await scanAllExchanges();
  const f = getFilters(chatId);
  
  if (f.mode === 'spot-futures') await showSpotFuturesResults(chatId, spotFuturesOpps, f);
  else if (f.mode === 'futures-futures') await showFuturesFuturesResults(chatId, futuresFuturesOpps, f);
  else if (f.mode === 'funding-rate') await showFundingRateResults(chatId, fundingOpps, f);
  else if (f.mode === 'fair-price') await showFairPriceResults(chatId, fairPriceOpps, f);
  else if (f.mode === 'cross-exchange') await showCrossExchangeResults(chatId, crossExchangeOpps, f);
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
    const volStr = opp.volume24h >= 1000000 ? `$${(opp.volume24h/1000000).toFixed(1)}M` : `$${(opp.volume24h/1000).toFixed(0)}K`;
    text += `${i+1}. ${emoji} <b>${opp.baseAsset}</b>: ${opp.spreadPercent.toFixed(2)}% | 📊 ${volStr}\n`;
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
    const volStr = opp.volume24h >= 1000000 ? `$${(opp.volume24h/1000000).toFixed(1)}M` : `$${(opp.volume24h/1000).toFixed(0)}K`;
    text += `${i+1}. ${emoji} <b>${opp.baseAsset}</b>: ${opp.spreadPercent.toFixed(3)}% | 📊 ${volStr}\n`;
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
    const volStr = opp.volume24h >= 1000000 ? `$${(opp.volume24h/1000000).toFixed(1)}M` : `$${(opp.volume24h/1000).toFixed(0)}K`;
    text += `${i+1}. ${emoji} <b>${opp.baseAsset}</b>: +${opp.dailyProfitPercent.toFixed(2)}%/день | 📊 ${volStr}\n`;
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
    const volStr = opp.volume24h >= 1000000 ? `$${(opp.volume24h/1000000).toFixed(1)}M` : `$${(opp.volume24h/1000).toFixed(0)}K`;
    text += `${i+1}. ${emoji} <b>${opp.baseAsset}</b>: ${opp.spreadPercent.toFixed(2)}% | 📊 ${volStr}\n`;
    text += `   💵 Fair: $${formatPrice(opp.fairPrice)}\n`;
    text += `   🟢 ${opp.undervaluedExchange}: ${opp.undervaluedDeviation.toFixed(2)}%\n`;
    text += `   🔴 ${opp.overvaluedExchange}: +${opp.overvaluedDeviation.toFixed(2)}%\n\n`;
  }
  
  await sendMessage(chatId, text, mainKeyboard);
}

async function showTriangularResults(chatId, opportunities, f) {
  // Filter by enabled exchanges
  const filtered = opportunities.filter(opp => {
    if (!f.enabledExchanges.includes(opp.exchange)) return false;
    return true;
  });
  
  if (filtered.length === 0) {
    await sendMessage(chatId, `🔺 <b>Triangular Arbitrage</b>\nНайдено: ${opportunities.length} | После фильтрации: 0\n\n💡 Мин. объём каждой пары: $500K\n💡 Прибыль уже за вычетом комиссий!`, mainKeyboard);
    return;
  }
  
  let text = `🔺 <b>Triangular Arbitrage</b>\nНайдено: ${opportunities.length} | Фильтр: ${filtered.length}\n💡 Прибыль за вычетом комиссий\n\n`;
  
  for (let i = 0; i < Math.min(10, filtered.length); i++) {
    const opp = filtered[i];
    const emoji = opp.profitPercent >= 1 ? '🔥' : opp.profitPercent >= 0.5 ? '⚡' : '📊';
    const volStr = opp.volume24h >= 1000000 ? `$${(opp.volume24h/1000000).toFixed(1)}M` : `$${(opp.volume24h/1000).toFixed(0)}K`;
    
    text += `${i+1}. ${emoji} <b>${opp.path}</b>\n`;
    text += `   💱 ${opp.exchange}: <b>+${opp.profitPercent.toFixed(3)}%</b>`;
    if (opp.totalFees) {
      text += ` (комиссия: ${opp.totalFees.toFixed(2)}%)`;
    }
    text += `\n`;
    text += `   💵 $${opp.startAmount.toFixed(0)} → $${opp.endAmount.toFixed(2)} | 📊 ${volStr}\n\n`;
  }
  
  await sendMessage(chatId, text, mainKeyboard);
}

async function showCrossExchangeResults(chatId, opportunities, f) {
  if (!opportunities || opportunities.length === 0) {
    await sendMessage(chatId, `🌐 <b>Cross-Exchange Triangle</b>\n\nНайдено: 0 возможностей\n\n💡 Каждый шаг на лучшей бирже!\n💡 Требует балансов на нескольких биржах`, mainKeyboard);
    return;
  }
  
  // Filter by enabled exchanges
  const filtered = opportunities.filter(opp => {
    const exchanges = opp.exchanges || [];
    return exchanges.some(ex => f.enabledExchanges.includes(ex));
  });
  
  let text = `🌐 <b>Cross-Exchange Triangle</b>\nНайдено: ${opportunities.length} | Фильтр: ${filtered.length}\n💡 Каждый шаг на лучшей бирже по цене\n\n`;
  
  for (let i = 0; i < Math.min(10, filtered.length); i++) {
    const opp = filtered[i];
    const emoji = opp.profitPercent >= 1 ? '🔥' : opp.profitPercent >= 0.5 ? '⚡' : '📊';
    const volStr = opp.volume24h >= 1000000 ? `$${(opp.volume24h/1000000).toFixed(1)}M` : `$${(opp.volume24h/1000).toFixed(0)}K`;
    
    text += `${i+1}. ${emoji} <b>${opp.path}</b>\n`;
    
    // Show each step with exchange
    if (opp.steps && opp.steps.length === 3) {
      text += `   ① ${opp.steps[0].action} ${opp.steps[0].asset} @ ${opp.steps[0].exchange}\n`;
      text += `   ② ${opp.steps[1].action} ${opp.steps[1].from}→${opp.steps[1].to} @ ${opp.steps[1].exchange}\n`;
      text += `   ③ ${opp.steps[2].action} ${opp.steps[2].asset} @ ${opp.steps[2].exchange}\n`;
    }
    
    text += `   💰 <b>+${opp.profitPercent.toFixed(3)}%</b>`;
    if (opp.totalFees) {
      text += ` (комиссии: ${opp.totalFees.toFixed(2)}%)`;
    }
    text += `\n   💵 $${opp.startAmount} → $${opp.endAmount.toFixed(2)} | 📊 ${volStr}\n\n`;
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
  else if (f.mode === 'cross-exchange') await showCrossExchangeResults(chatId, priceCache.crossExchangeOpps || [], f);
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
  else if (data === 'set_mode_cross-exchange') { f.mode = 'cross-exchange'; await sendMessage(chatId, '✅ Cross-Exchange Triangle', getFiltersKb(f)); }
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
      version: '7.0.0',
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
