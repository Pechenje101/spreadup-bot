# SpreadUP Bot - Vercel Deployment

Telegram бот для мониторинга арбитражных возможностей.

## Деплой на Vercel

### 1. Установка Vercel CLI
```bash
npm install -g vercel
```

### 2. Авторизация
```bash
vercel login
```

### 3. Деплой
```bash
cd vercel-bot
vercel
```

### 4. Настройка переменных окружения
В Vercel Dashboard → Settings → Environment Variables:
- `TELEGRAM_BOT_TOKEN` = `8476184475:AAEka7mj2waSrH1XV4z-PWwuMFxwTVVsbHg`

### 5. Установка Webhook
После деплоя установите webhook:

```bash
# Замените YOUR_VERCEL_URL на URL вашего проекта
curl "https://api.telegram.org/bot8476184475:AAEka7mj2waSrH1XV4z-PWwuMFxwTVVsbHg/setWebhook?url=https://YOUR_VERCEL_URL/webhook"
```

## Функции

- ✅ Мониторинг CEX бирж (MEXC, Gate.io, BingX, HTX, KuCoin)
- ✅ DEX алерты (Jupiter, Raydium, PancakeSwap, QuickSwap, Uniswap V3, Trader Joe, Aerodrome)
- ✅ Фильтры по спреду и объёму
- ✅ Управление DEX алертами (вкл/выкл)
- ✅ Выбор бирж для мониторинга

## Команды бота

- `/start` - Начать работу
- `/status` - Статус мониторинга
- `/filters` - Настроить фильтры
- `/scan` - Сканировать рынок
- `/top` - Топ спредов
- `/help` - Справка
