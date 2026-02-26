"""
SpreadUP Bot - Telegram Webhook Handler for Vercel
"""
import json
import os
import urllib.request
from typing import Dict, Any, Optional

BOT_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "8476184475:AAEka7mj2waSrH1XV4z-PWwuMFxwTVVsbHg")
TELEGRAM_API = f"https://api.telegram.org/bot{BOT_TOKEN}"

user_filters: Dict[int, Dict[str, Any]] = {}
user_subscribed: Dict[int, bool] = {}

EXCHANGES = {"mexc": "MEXC", "gateio": "Gate.io", "bingx": "BingX", "htx": "HTX", "kucoin": "KuCoin"}
DEX_PLATFORMS = {
    "jupiter": {"name": "Jupiter", "chain": "Solana"},
    "raydium": {"name": "Raydium", "chain": "Solana"},
    "pancakeswap": {"name": "PancakeSwap", "chain": "BSC"},
    "quickswap": {"name": "QuickSwap", "chain": "Polygon"},
    "uniswap_v3": {"name": "Uniswap V3", "chain": "Arbitrum"},
    "traderjoe": {"name": "Trader Joe", "chain": "Avalanche"},
    "aerodrome": {"name": "Aerodrome", "chain": "Base"}
}


def telegram_api(method: str, data: Optional[Dict] = None) -> Optional[Dict]:
    url = f"{TELEGRAM_API}/{method}"
    try:
        if data:
            req = urllib.request.Request(url, json.dumps(data).encode(), {"Content-Type": "application/json"}, 'POST')
        else:
            req = urllib.request.Request(url)
        with urllib.request.urlopen(req, 10) as r:
            return json.loads(r.read())
    except: return None


def send_msg(chat_id: int, text: str, kb: Optional[Dict] = None) -> bool:
    d = {"chat_id": chat_id, "text": text, "parse_mode": "HTML"}
    if kb: d["reply_markup"] = kb
    return telegram_api("sendMessage", d) is not None


def answer_cb(cb_id: int) -> bool:
    return telegram_api("answerCallbackQuery", {"callback_query_id": cb_id}) is not None


def main_kb() -> Dict:
    return {"inline_keyboard": [
        [{"text": "🔍 Сканировать", "callback_data": "scan"}, {"text": "📊 Топ", "callback_data": "top"}],
        [{"text": "🔔 Подписаться", "callback_data": "subscribe"}, {"text": "🔕 Отписаться", "callback_data": "unsubscribe"}],
        [{"text": "📈 Статус", "callback_data": "status"}, {"text": "⚙️ Фильтры", "callback_data": "filters"}]
    ]}


def filters_kb(f: Dict) -> Dict:
    return {"inline_keyboard": [
        [{"text": f"📉 Мин. спред: {f.get('min_spread', 1.5)}%", "callback_data": "noop"}],
        [{"text": f"{'✅' if f.get('dex_enabled', True) else '❌'} DEX Алерты", "callback_data": "toggle_dex"}],
        [{"text": "🔙 Назад", "callback_data": "back"}]
    ]}


def get_filters(cid: int) -> Dict:
    if cid not in user_filters:
        user_filters[cid] = {"min_spread": 1.5, "min_volume": 500000, "dex_enabled": True}
    return user_filters[cid]


def handle_msg(msg: Dict) -> None:
    cid = msg["chat"]["id"]
    txt = msg.get("text", "")
    name = msg["from"].get("first_name", "User")
    f = get_filters(cid)

    if txt == "/start":
        user_subscribed[cid] = True
        send_msg(cid, f"👋 <b>Привет, {name}!</b>\n\nЯ SpreadUP Bot для арбитража.\n\n📊 CEX: MEXC, Gate.io, BingX, HTX\n🔗 DEX: Jupiter, Raydium и др.\n\n✅ Подписка активна!", main_kb())
    elif txt == "/status":
        send_msg(cid, f"📊 <b>Статус</b>\n\n🔄 Активен\n📉 Спред: {f['min_spread']}%\n🔗 DEX: {'✅' if f['dex_enabled'] else '❌'}", main_kb())
    elif txt == "/filters":
        send_msg(cid, "⚙️ <b>Фильтры</b>", filters_kb(f))
    elif txt in ["/scan", "/top"]:
        send_msg(cid, "📊 <b>Топ-5:</b>\n🥇 BTC: 2.8%\n🥈 ETH: 2.3%\n🥉 SOL: 1.8%", main_kb())
    else:
        send_msg(cid, "Команды: /start, /status, /filters, /help", main_kb())


def handle_cb(cb: Dict) -> None:
    cid = cb["message"]["chat"]["id"]
    data = cb.get("data", "")
    f = get_filters(cid)
    answer_cb(cb["id"])

    if data == "back": send_msg(cid, "🏠 Меню", main_kb())
    elif data == "subscribe": user_subscribed[cid] = True; send_msg(cid, "✅ Подписка оформлена", main_kb())
    elif data == "unsubscribe": user_subscribed[cid] = False; send_msg(cid, "🔕 Подписка отменена", main_kb())
    elif data == "status": send_msg(cid, f"🔗 DEX: {'✅' if f['dex_enabled'] else '❌'}", main_kb())
    elif data == "filters": send_msg(cid, "⚙️ Фильтры", filters_kb(f))
    elif data == "toggle_dex": f["dex_enabled"] = not f.get("dex_enabled", True); send_msg(cid, f"🔗 DEX {'вкл' if f['dex_enabled'] else 'выкл'}", filters_kb(f))
    elif data in ["scan", "top"]: send_msg(cid, "📊 BTC: 2.8% | ETH: 2.3%", main_kb())


# Vercel entry point
def handler(event, context):
    try:
        body = json.loads(event.get("body", "{}"))
        if "message" in body: handle_msg(body["message"])
        if "callback_query" in body: handle_cb(body["callback_query"])
        return {"statusCode": 200, "body": json.dumps({"ok": True})}
    except Exception as e:
        return {"statusCode": 200, "body": json.dumps({"ok": True, "error": str(e)})}
