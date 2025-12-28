import os
import json
import time
import random
import logging
from pathlib import Path
from datetime import datetime, timedelta

import requests
from dotenv import load_dotenv

logging.basicConfig(level=logging.INFO, format="%(asctime)s | %(levelname)s | %(message)s")
log = logging.getLogger("europa-alert")

STATE_FILE = Path("state_best.json")


# -----------------------------
# Helpers ENV
# -----------------------------
def load_env():
    load_dotenv(override=True)


def env_str(name: str, default: str = "") -> str:
    return (os.getenv(name) or default).strip()


def env_int(name: str, default: int) -> int:
    v = env_str(name, str(default))
    try:
        return int(v)
    except ValueError:
        return default


def env_float(name: str, default: float) -> float:
    v = env_str(name, str(default))
    try:
        return float(v)
    except ValueError:
        return default


def base_url(env_name: str) -> str:
    return "https://api.amadeus.com" if env_name.lower() == "prod" else "https://test.api.amadeus.com"


# -----------------------------
# Telegram
# -----------------------------
def telegram_send(token: str, chat_id: str, text: str) -> None:
    if not token or not chat_id:
        log.warning("Telegram no configurado (faltan TELEGRAM_TOKEN / TELEGRAM_CHAT_ID).")
        return
    url = f"https://api.telegram.org/bot{token}/sendMessage"
    try:
        r = requests.post(
            url,
            data={"chat_id": chat_id, "text": text, "disable_web_page_preview": True},
            timeout=15,
        )
        if not r.ok:
            log.warning("Telegram error %s: %s", r.status_code, r.text[:200])
        else:
            log.info("Telegram OK.")
    except requests.RequestException as e:
        log.warning("Telegram request error: %s", e)


# -----------------------------
# State
# -----------------------------
def state_load() -> dict:
    if not STATE_FILE.exists():
        return {"best_total": None, "best_offer": None}
    try:
        return json.loads(STATE_FILE.read_text(encoding="utf-8"))
    except Exception:
        return {"best_total": None, "best_offer": None}


def state_save(state: dict) -> None:
    STATE_FILE.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")


# -----------------------------
# Amadeus Client
# -----------------------------
class Amadeus:
    def __init__(self, env_name: str, client_id: str, client_secret: str):
        self.base = base_url(env_name)
        self.client_id = client_id
        self.client_secret = client_secret
        self.token = None
        self.token_exp = 0.0
        self.airline_name_cache = {}  # "IB" -> "Iberia"

    def _token_valid(self) -> bool:
        return bool(self.token) and (time.time() < (self.token_exp - 30))

    def get_token(self) -> str:
        if self._token_valid():
            return self.token

        url = f"{self.base}/v1/security/oauth2/token"
        r = requests.post(
            url,
            headers={"Content-Type": "application/x-www-form-urlencoded"},
            data={
                "grant_type": "client_credentials",
                "client_id": self.client_id,
                "client_secret": self.client_secret,
            },
            timeout=20,
        )
        r.raise_for_status()
        js = r.json()
        self.token = js["access_token"]
        self.token_exp = time.time() + int(js.get("expires_in", 900))
        return self.token

    def _headers(self) -> dict:
        return {"Authorization": f"Bearer {self.get_token()}"}

    def request(self, method: str, path: str, params: dict | None = None, retries: int = 4) -> requests.Response | None:
        url = f"{self.base}{path}"
        params = params or {}

        for attempt in range(1, retries + 1):
            try:
                r = requests.request(method, url, headers=self._headers(), params=params, timeout=30)

                # token expirado
                if r.status_code == 401 and attempt < retries:
                    self.token = None
                    time.sleep(0.5)
                    continue

                # backoff
                if r.status_code in (429, 500, 502, 503, 504) and attempt < retries:
                    wait = (2 ** (attempt - 1)) + random.uniform(0, 0.5)
                    log.warning("HTTP %s %s (retry %s/%s) wait %.1fs", r.status_code, path, attempt, retries, wait)
                    time.sleep(wait)
                    continue

                return r

            except requests.RequestException as e:
                if attempt == retries:
                    log.warning("Request error final %s %s: %s", method, path, e)
                    return None
                wait = (2 ** (attempt - 1)) + random.uniform(0, 0.5)
                log.warning("Request error (retry %s/%s) wait %.1fs: %s", attempt, retries, wait, e)
                time.sleep(wait)

        return None

    def flight_offers(self, origin: str, dest: str, depart: str, ret: str, adults: int, currency: str, max_results: int):
        params = {
            "originLocationCode": origin,
            "destinationLocationCode": dest,
            "departureDate": depart,
            "returnDate": ret,
            "adults": adults,
            "currencyCode": currency,
            "max": max_results,
        }
        return self.request("GET", "/v2/shopping/flight-offers", params=params)

    def airline_name(self, code: str) -> str | None:
        code = (code or "").strip().upper()
        if not code:
            return None
        if code in self.airline_name_cache:
            return self.airline_name_cache[code]

        # Endpoint: /v1/reference-data/airlines?airlineCodes=IB
        r = self.request("GET", "/v1/reference-data/airlines", params={"airlineCodes": code}, retries=3)
        if r is None or not r.ok:
            self.airline_name_cache[code] = None
            return None

        try:
            data = r.json().get("data", []) or []
            if not data:
                self.airline_name_cache[code] = None
                return None
            name = (data[0].get("businessName") or data[0].get("commonName") or data[0].get("name") or "").strip()
            self.airline_name_cache[code] = name or None
            return self.airline_name_cache[code]
        except Exception:
            self.airline_name_cache[code] = None
            return None


# -----------------------------
# Offer parsing
# -----------------------------
def pick_cheapest_offer(offers: list[dict]) -> dict | None:
    if not offers:
        return None
    try:
        return min(offers, key=lambda x: float(x["price"]["total"]))
    except Exception:
        return None


def extract_airlines(offer: dict) -> dict:
    validating = offer.get("validatingAirlineCodes", []) or []
    carriers = set()
    for it in offer.get("itineraries", []) or []:
        for seg in it.get("segments", []) or []:
            cc = (seg.get("carrierCode") or "").strip().upper()
            if cc:
                carriers.add(cc)
    return {"validating": [c.strip().upper() for c in validating if c], "carriers": sorted(carriers)}


def format_airlines(am: Amadeus, validating: list[str], carriers: list[str]) -> str:
    # Priorizamos validating; si no hay, usamos carriers
    codes = validating or carriers
    parts = []
    for c in codes[:5]:  # evitamos spam
        name = am.airline_name(c)
        if name:
            parts.append(f"{name} ({c})")
        else:
            parts.append(c)
    # Si hay más carriers, lo indicamos
    if len(codes) > 5:
        parts.append(f"+{len(codes)-5} más")
    return ", ".join(parts) if parts else "N/D"


# -----------------------------
# Main
# -----------------------------
def main():
    load_env()

    am_env = env_str("AMADEUS_ENV", "test")
    am_id = env_str("AMADEUS_CLIENT_ID")
    am_secret = env_str("AMADEUS_CLIENT_SECRET")

    tg_token = env_str("TELEGRAM_TOKEN")
    tg_chat = env_str("TELEGRAM_CHAT_ID")

    origin = env_str("ORIGIN", "EZE").upper()
    currency = env_str("CURRENCY", "USD").upper()
    max_price = env_int("MAX_PRICE", 1250)

    destinations = [d.strip().upper() for d in env_str("DESTINATIONS", "MAD,BCN,LIS").split(",") if d.strip()]

    start_in_days = env_int("START_IN_DAYS", 30)
    range_days = env_int("RANGE_DAYS", 180)
    step_days = env_int("STEP_DAYS", 7)

    dur_min = env_int("DUR_MIN", 15)
    dur_max = env_int("DUR_MAX", 25)

    adults = env_int("ADULTS", 1)
    max_results = env_int("MAX", 10)
    sleep_s = env_float("SLEEP", 0.15)

    log.info(
        "DEBUG env: TELEGRAM_TOKEN=%s | TELEGRAM_CHAT_ID=%s | AMADEUS_CLIENT_ID=%s",
        bool(tg_token),
        bool(tg_chat),
        bool(am_id),
    )

    if not am_id or not am_secret:
        raise RuntimeError("Faltan AMADEUS_CLIENT_ID / AMADEUS_CLIENT_SECRET en .env")

    am = Amadeus(am_env, am_id, am_secret)
    state = state_load()
    prev_best = state.get("best_total")

    today = datetime.now().date()
    start_date = today + timedelta(days=start_in_days)
    end_date = start_date + timedelta(days=range_days)

    log.info(
        "Buscando %s -> Europa | destinos=%s | %s..%s | dur=%s-%s | max=%s %s | env=%s",
        origin,
        len(destinations),
        start_date,
        end_date,
        dur_min,
        dur_max,
        max_price,
        currency,
        am_env,
    )

    best = None  # dict con info del mejor

    dep = start_date
    while dep <= end_date:
        depart_str = dep.strftime("%Y-%m-%d")

        for duration in range(dur_min, dur_max + 1):
            ret_date = dep + timedelta(days=duration)
            ret_str = ret_date.strftime("%Y-%m-%d")

            for dest in destinations:
                if sleep_s > 0:
                    time.sleep(sleep_s)

                r = am.flight_offers(origin, dest, depart_str, ret_str, adults, currency, max_results)
                if r is None:
                    continue

                if not r.ok:
                    log.warning("FAIL %s %s->%s %s/%s : %s", r.status_code, origin, dest, depart_str, ret_str, (r.text or "")[:140])
                    continue

                js = r.json()
                offers = js.get("data", []) or []
                cheapest = pick_cheapest_offer(offers)
                if not cheapest:
                    continue

                try:
                    total = float(cheapest["price"]["total"])
                except Exception:
                    continue

                # solo consideramos candidatos por debajo del objetivo
                if total > max_price:
                    continue

                air = extract_airlines(cheapest)
                cand = {
                    "total": total,
                    "currency": currency,
                    "origin": origin,
                    "dest": dest,
                    "depart": depart_str,
                    "return": ret_str,
                    "duration_days": duration,
                    "validating": air["validating"],
                    "carriers": air["carriers"],
                }

                if best is None or cand["total"] < best["total"]:
                    best = cand
                    log.info(
                        "NUEVO BEST: %.2f %s | %s -> %s (%sd) %s->%s | validating=%s | carriers=%s",
                        best["total"],
                        best["currency"],
                        best["depart"],
                        best["return"],
                        best["duration_days"],
                        best["origin"],
                        best["dest"],
                        best["validating"],
                        best["carriers"],
                    )

        dep += timedelta(days=step_days)

    if not best:
        log.info("No encontré nada <= %s %s en el rango.", max_price, currency)
        return

    improved = (prev_best is None) or (best["total"] < float(prev_best))

    airline_line = format_airlines(am, best["validating"], best["carriers"])
    msg = (
        "✈️ Alerta: Europa barata\n"
        f"{best['origin']} → {best['dest']} (ida/vuelta)\n"
        f"Salida: {best['depart']} | Vuelta: {best['return']} ({best['duration_days']} días)\n"
        f"Total: {best['total']:.2f} {best['currency']}\n"
        f"Aerolínea(s): {airline_line}\n"
    )

    if improved:
        state = {
            "best_total": best["total"],
            "best_offer": best,
            "updated_at": datetime.now().isoformat(timespec="seconds"),
        }
        state_save(state)
        telegram_send(tg_token, tg_chat, msg)
        log.info("Alerta enviada y best guardado en %s", STATE_FILE.name)
    else:
        log.info("Encontré %.2f %s pero no mejora el best guardado (%s).", best["total"], currency, prev_best)
        # opcional: igual avisar en telegram si querés
        # telegram_send(tg_token, tg_chat, msg)


if __name__ == "__main__":
    main()
