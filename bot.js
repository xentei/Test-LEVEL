import fetch from 'node-fetch';
import TelegramBot from 'node-telegram-bot-api';
import 'dotenv/config';
import cron from 'cron';

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const API_URL = process.env.API_URL;
const PRICE_THRESHOLD = parseFloat(process.env.PRICE_THRESHOLD) || 250;

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: false });
let initialized = false;

const sendMessage = async (message) => {
  try {
    await bot.sendMessage(TELEGRAM_CHAT_ID, message, { parse_mode: 'Markdown' });
  } catch (err) {
    console.error("Error enviando mensaje:", err.message);
  }
};

const fetchFlightData = async () => {
  try {
    const res = await fetch(API_URL, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        'Accept': 'application/json'
      }
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);

    const data = await res.json();

    if (!Array.isArray(data.vuelos)) throw new Error("Formato inesperado");

    const ofertas = data.vuelos.filter(vuelo => vuelo.precio < PRICE_THRESHOLD);

    if (!initialized) {
      initialized = true;
      await sendMessage("🚀 El bot de vuelos ha iniciado correctamente.");
    }

    if (ofertas.length > 0) {
      for (const vuelo of ofertas) {
        await sendMessage(`🔔 *¡Oferta encontrada!*\n📅 Fecha: ${vuelo.fecha}\n💵 Precio: $${vuelo.precio}`);
      }
    }
  } catch (err) {
    console.error("❌ Error al consultar la API:", err.message);
  }
};

// Ejecutar cada 2 minutos
const job = new cron.CronJob('*/2 * * * *', fetchFlightData, null, true, 'America/Argentina/Buenos_Aires');

// Notificación inmediata al iniciar
(async () => {
  console.log("🟢 Servicio de bot iniciado.");
  try {
    await sendMessage("🚀 Servicio de bot iniciado.");
  } catch (e) {
    console.error("⚠️ No se pudo enviar mensaje inicial:", e.message);
  }
})();
