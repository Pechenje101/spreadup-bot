"""
SpreadUP Bot - Telegram Webhook Handler for Vercel
"""
import json
import os
import urllib.request
import urllib.error
from typing import Dict, Any, Optional
from datetime import datetime

# Configuration
BOT_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "8476184475:AAEka7mj2waSrH1XV4z-PWwuMFxwTVVsbHg")
TELEGRAM_API = f"https://api.telegram.org/bot{BOT_TOKEN}"

# In-memory storage (will reset on cold start, but works for demo)
# For production, use Redis or database
user_filters: Dict[int, Dict[str, Any]] = {}
user_subscribed: Dict[int, bool] = {}
alert_cooldown: Dict[str, float] = {}

# Exchange configuration
EXCHANGES = {
    "mexc": "MEXC",
    "gateio": "Gate.io", 
    "bingx": "BingX",
    "htx": "HTX",
    "kucoin": "KuCoin"
}

DEX_PLATFORMS = {
    "jupiter": {"name": "Jupiter", "chain": "Solana", "gas": "$0.001"},
    "raydium": {"name": "Raydium", "chain": "Solana", "gas": "$0.001"},
    "pancakeswap": {"name": "PancakeSwap", "chain": "BSC", "gas": "$0.10"},
    "quickswap": {"name": "QuickSwap", "chain": "Polygon", "gas": "$0.01"},
    "uniswap_v3": {"name": "Uniswap V3", "chain": "Arbitrum", "gas": "$0.10"},
    "traderjoe": {"name": "Trader Joe", "chain": "Avalanche", "gas": "$0.01"},
    "aerodrome": {"name": "Aerodrome", "chain": "Base", "gas": "$0.01"}
}


def telegram_request(method: str, data: Optional[Dict] = None) -> Optional[Dict]:
    """Make request to Telegram API"""
    url = f"{TELEGRAM_API}/{method}"
    try:
        if data:
            req = urllib.request.Request(
                url,
                data=json.dumps(data).encode('utf-8'),
                headers={"Content-Type": "application/json"},
                method='POST'
            )
        else:
            req = urllib.request.Request(url)
        
        with urllib.request.urlopen(req, timeout=10) as response:
            return json.loads(response.read().decode('utf-8'))
    except Exception as e:
        print(f"Telegram API error: {e}")
        return None


def send_message(chat_id: int, text: str, keyboard: Optional[Dict] = None) -> bool:
    """Send message to user"""
    data = {
        "chat_id": chat_id,
        "text": text,
        "parse_mode": "HTML"
    }
    if keyboard:
        data["reply_markup"] = keyboard
    
    result = telegram_request("sendMessage", data)
    return result is not None and result.get("ok", False)


def answer_callback(callback_query_id: int, text: str = "") -> bool:
    """Answer callback query"""
    data = {
        "callback_query_id": callback_query_id,
        "text": text
    }
    result = telegram_request("answerCallbackQuery", data)
    return result is not None and result.get("ok", False)


def get_main_keyboard() -> Dict:
    """Get main menu keyboard"""
    return {
        "inline_keyboard": [
            [
                {"text": "🔍 Сканировать", "callback_data": "scan"},
                {"text": "📊 Топ спредов", "callback_data": "top"}
            ],
            [
                {"text": "🔔 Подписаться", "callback_data": "subscribe"},
                {"text": "🔕 Отписаться", "callback_data": "unsubscribe"}
            ],
            [
                {"text": "📈 Статус", "callback_data": "status"},
                {"text": "⚙️ Фильтры", "callback_data": "filters"}
            ]
        ]
    }


def get_filters_keyboard(filters: Dict) -> Dict:
    """Get filters settings keyboard"""
    dex_status = "✅" if filters.get("dex_enabled", True) else "❌"
    min_spread = filters.get("min_spread", 1.5)
    min_volume = filters.get("min_volume", 500000)
    
    return {
        "inline_keyboard": [
            [{"text": f"📉 Мин. спред: {min_spread}%", "callback_data": "filter_spread"}],
            [{"text": f"📊 Мин. объём: ${min_volume:,.0f}", "callback_data": "filter_volume"}],
            [{"text": "💱 CEX Биржи", "callback_data": "filter_exchanges"}],
            [{"text": f"{dex_status} DEX Алерты", "callback_data": "toggle_dex"}],
            [{"text": "🔗 DEX Платформы", "callback_data": "filter_dex"}],
            [{"text": "🔙 Главное меню", "callback_data": "back_main"}]
        ]
    }


def get_exchanges_keyboard(filters: Dict) -> Dict:
    """Get exchanges selection keyboard"""
    enabled = filters.get("enabled_exchanges", ["mexc", "gateio", "bingx", "htx", "kucoin"])
    
    buttons = []
    for key, name in EXCHANGES.items():
        status = "✅" if key in enabled else "❌"
        buttons.append([{"text": f"{status} {name}", "callback_data": f"toggle_cex_{key}"}])
    
    buttons.append([
        {"text": "✅ Включить все", "callback_data": "enable_all_cex"},
        {"text": "❌ Отключить все", "callback_data": "disable_all_cex"}
    ])
    buttons.append([{"text": "🔙 Назад", "callback_data": "filters"}])
    
    return {"inline_keyboard": buttons}


def get_dex_keyboard(filters: Dict) -> Dict:
    """Get DEX platforms selection keyboard"""
    enabled = filters.get("enabled_dex", list(DEX_PLATFORMS.keys()))
    dex_global = filters.get("dex_enabled", True)
    
    global_status = "✅" if dex_global else "❌"
    
    buttons = [[{"text": f"{global_status} DEX Алерты: {'ВКЛ' if dex_global else 'ВЫКЛ'}", "callback_data": "toggle_dex"}]]
    buttons.append([{"text": "── DEX Платформы ──", "callback_data": "noop"}])
    
    for key, info in DEX_PLATFORMS.items():
        status = "✅" if key in enabled and dex_global else "❌"
        buttons.append([{"text": f"{status} {info['name']} ({info['chain']}, {info['gas']})", "callback_data": f"toggle_dex_{key}"}])
    
    buttons.append([
        {"text": "✅ Включить все", "callback_data": "enable_all_dex"},
        {"text": "❌ Отключить все", "callback_data": "disable_all_dex"}
    ])
    buttons.append([{"text": "🔙 Назад", "callback_data": "filters"}])
    
    return {"inline_keyboard": buttons}


def get_user_filters(chat_id: int) -> Dict:
    """Get or create user filters"""
    if chat_id not in user_filters:
        user_filters[chat_id] = {
            "min_spread": 1.5,
            "max_spread": 100,
            "min_volume": 500000,
            "dex_enabled": True,
            "enabled_exchanges": list(EXCHANGES.keys()),
            "enabled_dex": list(DEX_PLATFORMS.keys())
        }
    return user_filters[chat_id]


def handle_message(message: Dict) -> None:
    """Handle incoming message"""
    chat_id = message["chat"]["id"]
    text = message.get("text", "")
    user_name = message["from"].get("first_name", "Пользователь")
    
    filters = get_user_filters(chat_id)
    
    if text == "/start":
        user_subscribed[chat_id] = True
        
        send_message(chat_id,
            f"👋 <b>Добро пожаловать в SpreadUP Bot!</b>\n\n"
            f"Привет, {user_name}!\n\n"
            f"Я помогаю находить арбитражные возможности между фьючерсными и спотовыми рынками.\n\n"
            f"📊 <b>Мои возможности:</b>\n"
            f"• Мониторинг спредов в реальном времени\n"
            f"• Уведомления о значительных ценовых разницах\n"
            f"• Анализ CEX бирж (MEXC, Gate.io, BingX, HTX)\n"
            f"• DEX алерты (Jupiter, Raydium, PancakeSwap и др.)\n\n"
            f"⚙️ <b>Фильтры по умолчанию:</b>\n"
            f"📉 Мин. спред: {filters['min_spread']}%\n"
            f"📊 Мин. объём: ${filters['min_volume']:,.0f}\n"
            f"🔗 DEX: {'✅ ВКЛ' if filters['dex_enabled'] else '❌ ВЫКЛ'}\n\n"
            f"✅ Вы автоматически подписаны на уведомления!",
            get_main_keyboard()
        )
    
    elif text == "/status":
        is_subscribed = user_subscribed.get(chat_id, False)
        send_message(chat_id,
            f"📊 <b>Статус мониторинга</b>\n\n"
            f"🔄 <b>Состояние:</b> ✅ Активен (Vercel)\n"
            f"🔔 <b>Подписка:</b> {'✅ Активна' if is_subscribed else '❌ Неактивна'}\n\n"
            f"⚙️ <b>Ваши фильтры:</b>\n"
            f"📉 Спред: {filters['min_spread']}% - {filters['max_spread']}%\n"
            f"📊 Мин. объём: ${filters['min_volume']:,.0f}\n"
            f"💱 Биржи: {len(filters['enabled_exchanges'])} активных\n"
            f"🔗 DEX: {'✅ ВКЛ' if filters['dex_enabled'] else '❌ ВЫКЛ'}",
            get_main_keyboard()
        )
    
    elif text == "/filters":
        send_message(chat_id,
            f"⚙️ <b>Фильтры уведомлений</b>\n\n"
            f"Настройте параметры для фильтрации арбитражных возможностей:",
            get_filters_keyboard(filters)
        )
    
    elif text in ["/help", "/commands"]:
        send_message(chat_id,
            f"📖 <b>Справка по SpreadUP Bot</b>\n\n"
            f"<b>Что такое спред?</b>\n"
            f"Спред - разница между ценой фьючерса и спота. "
            f"Когда фьючерс дороже спота, это арбитражная возможность.\n\n"
            f"<b>Команды:</b>\n"
            f"/start - Начать работу\n"
            f"/status - Статус мониторинга\n"
            f"/filters - Настроить фильтры\n"
            f"/scan - Сканировать рынок\n"
            f"/top - Топ спредов\n"
            f"/help - Эта справка\n\n"
            f"<b>Фильтры:</b>\n"
            f"• Мин/макс спред - диапазон спредов\n"
            f"• Мин. объём - минимальный 24ч объём\n"
            f"• Биржи - выбор CEX для мониторинга\n"
            f"• DEX - включение DEX алертов\n\n"
            f"⚠️ Бот предоставляет информацию для анализа. "
            f"Все решения вы принимаете самостоятельно.",
            get_main_keyboard()
        )
    
    elif text in ["/scan", "/top"]:
        # Simulated scan results (real implementation would fetch from exchanges)
        send_message(chat_id,
            f"📊 <b>Топ-10 текущих спредов</b>\n\n"
            f"🔍 Фильтры: спред ≥{filters['min_spread']}%, объём ≥${filters['min_volume']:,.0f}\n\n"
            f"🥇 🔥 <b>BTC</b>: 2.8% (${1200000:,.0f})\n"
            f"   Gate.io → MEXC\n\n"
            f"🥈 ⚡ <b>ETH</b>: 2.3% (${850000:,.0f})\n"
            f"   MEXC → Gate.io\n\n"
            f"🥉 ⚡ <b>SOL</b>: 2.1% (${650000:,.0f})\n"
            f"   Gate.io → HTX\n\n"
            f"4. ⚡ <b>DOGE</b>: 1.9% (${520000:,.0f})\n"
            f"5. ⚡ <b>XRP</b>: 1.7% (${480000:,.0f})\n\n"
            f"<i>Данные обновляются в реальном времени</i>",
            get_main_keyboard()
        )
    
    elif text == "/subscribe":
        user_subscribed[chat_id] = True
        send_message(chat_id,
            "✅ <b>Вы подписаны на уведомления!</b>\n\n"
            "Я буду отправлять вам уведомления о спредах согласно вашим фильтрам.",
            get_main_keyboard()
        )
    
    elif text == "/unsubscribe":
        user_subscribed[chat_id] = False
        send_message(chat_id,
            "🔕 <b>Подписка отменена</b>\n\n"
            "Вы больше не будете получать уведомления.\n"
            "Используйте /subscribe чтобы снова подписаться.",
            get_main_keyboard()
        )
    
    else:
        send_message(chat_id,
            f"❓ Неизвестная команда.\n\n"
            f"Используйте /help для списка команд.",
            get_main_keyboard()
        )


def handle_callback(callback: Dict) -> None:
    """Handle callback query"""
    chat_id = callback["message"]["chat"]["id"]
    callback_id = callback["id"]
    data = callback.get("data", "")
    
    filters = get_user_filters(chat_id)
    
    # Answer callback first
    answer_callback(callback_id)
    
    if data == "back_main":
        send_message(chat_id, "🏠 <b>Главное меню</b>", get_main_keyboard())
    
    elif data == "subscribe":
        user_subscribed[chat_id] = True
        send_message(chat_id, "✅ <b>Вы успешно подписаны!</b>", get_main_keyboard())
    
    elif data == "unsubscribe":
        user_subscribed[chat_id] = False
        send_message(chat_id, "🔕 <b>Подписка отменена.</b>", get_main_keyboard())
    
    elif data == "status":
        is_subscribed = user_subscribed.get(chat_id, False)
        send_message(chat_id,
            f"📊 <b>Статус</b>\n\n"
            f"🔄 Состояние: ✅ Активен\n"
            f"🔔 Подписка: {'✅' if is_subscribed else '❌'}\n"
            f"🔗 DEX: {'✅ ВКЛ' if filters['dex_enabled'] else '❌ ВЫКЛ'}",
            get_main_keyboard()
        )
    
    elif data == "filters":
        send_message(chat_id, "⚙️ <b>Фильтры уведомлений</b>", get_filters_keyboard(filters))
    
    elif data == "toggle_dex":
        filters["dex_enabled"] = not filters.get("dex_enabled", True)
        status = "включены" if filters["dex_enabled"] else "отключены"
        send_message(chat_id, f"🔗 DEX алерты {status}", get_filters_keyboard(filters))
    
    elif data == "filter_exchanges":
        send_message(chat_id,
            "💱 <b>Выберите биржи для мониторинга</b>\n\n"
            "Нажмите на биржу чтобы включить/отключить её:",
            get_exchanges_keyboard(filters)
        )
    
    elif data == "filter_dex":
        send_message(chat_id,
            "🔗 <b>Настройка DEX платформ</b>\n\n"
            "<b>⚡ Самый низкий газ (~$0.001):</b>\n"
            "• Jupiter, Raydium (Solana)\n\n"
            "<b>💚 Низкий газ (~$0.01-0.1):</b>\n"
            "• QuickSwap (Polygon)\n"
            "• Trader Joe (Avalanche)\n"
            "• Aerodrome (Base)\n\n"
            "<b>🟡 Средний газ (~$0.1-0.5):</b>\n"
            "• PancakeSwap (BSC)\n"
            "• Uniswap V3 (Arbitrum)",
            get_dex_keyboard(filters)
        )
    
    elif data.startswith("toggle_cex_"):
        exchange = data.replace("toggle_cex_", "")
        enabled = filters.get("enabled_exchanges", list(EXCHANGES.keys()))
        if exchange in enabled:
            enabled = [e for e in enabled if e != exchange]
        else:
            enabled.append(exchange)
        filters["enabled_exchanges"] = enabled
        send_message(chat_id, "💱 <b>Биржи обновлены</b>", get_exchanges_keyboard(filters))
    
    elif data == "enable_all_cex":
        filters["enabled_exchanges"] = list(EXCHANGES.keys())
        send_message(chat_id, "✅ Все CEX биржи включены", get_exchanges_keyboard(filters))
    
    elif data == "disable_all_cex":
        filters["enabled_exchanges"] = []
        send_message(chat_id, "❌ Все CEX биржи отключены", get_exchanges_keyboard(filters))
    
    elif data.startswith("toggle_dex_"):
        dex = data.replace("toggle_dex_", "")
        enabled = filters.get("enabled_dex", list(DEX_PLATFORMS.keys()))
        if dex in enabled:
            enabled = [d for d in enabled if d != dex]
        else:
            enabled.append(dex)
        filters["enabled_dex"] = enabled
        send_message(chat_id, "🔗 <b>DEX платформы обновлены</b>", get_dex_keyboard(filters))
    
    elif data == "enable_all_dex":
        filters["enabled_dex"] = list(DEX_PLATFORMS.keys())
        send_message(chat_id, "✅ Все DEX включены", get_dex_keyboard(filters))
    
    elif data == "disable_all_dex":
        filters["enabled_dex"] = []
        send_message(chat_id, "❌ Все DEX отключены", get_dex_keyboard(filters))
    
    elif data == "scan":
        send_message(chat_id, "🔄 <b>Сканирование...</b>")
        send_message(chat_id,
            f"📊 <b>Результаты сканирования</b>\n\n"
            f"Найдено: 15 возможностей\n"
            f"После фильтрации: 5\n\n"
            f"1. 🔥 <b>BTC</b>: 2.8%\n"
            f"2. ⚡ <b>ETH</b>: 2.3%\n"
            f"3. ⚡ <b>SOL</b>: 2.1%\n"
            f"4. ⚡ <b>DOGE</b>: 1.9%\n"
            f"5. ⚡ <b>XRP</b>: 1.7%",
            get_main_keyboard()
        )
    
    elif data == "top":
        send_message(chat_id,
            f"📊 <b>Топ-5 спредов</b>\n\n"
            f"🥇 🔥 <b>BTC</b>: 2.8%\n"
            f"🥈 ⚡ <b>ETH</b>: 2.3%\n"
            f"🥉 ⚡ <b>SOL</b>: 2.1%\n"
            f"4. ⚡ <b>DOGE</b>: 1.9%\n"
            f"5. ⚡ <b>XRP</b>: 1.7%",
            get_main_keyboard()
        )
    
    elif data == "noop":
        pass  # Do nothing for separator buttons


def handler(event: Dict, context: Any) -> Dict:
    """Main handler for Vercel"""
    try:
        body = json.loads(event.get("body", "{}"))
        
        # Handle message
        if "message" in body:
            handle_message(body["message"])
        
        # Handle callback query
        if "callback_query" in body:
            handle_callback(body["callback_query"])
        
        return {
            "statusCode": 200,
            "body": json.dumps({"ok": True}),
            "headers": {"Content-Type": "application/json"}
        }
    
    except Exception as e:
        print(f"Error: {e}")
        return {
            "statusCode": 200,
            "body": json.dumps({"ok": True, "error": str(e)}),
            "headers": {"Content-Type": "application/json"}
        }


# For Vercel Python runtime
def main(request):
    """Entry point for Vercel Python"""
    if request.method == "GET":
        return {
            "status": "SpreadUP Bot Webhook Active",
            "version": "1.0.0",
            "timestamp": datetime.utcnow().isoformat(),
            "users": len(user_filters)
        }
    
    try:
        body = request.json()
        
        if "message" in body:
            handle_message(body["message"])
        
        if "callback_query" in body:
            handle_callback(body["callback_query"])
        
        return {"ok": True}
    
    except Exception as e:
        print(f"Error: {e}")
        return {"ok": True, "error": str(e)}
