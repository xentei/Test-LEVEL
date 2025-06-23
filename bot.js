import fetch from 'node-fetch';
import TelegramBot from 'node-telegram-bot-api';
import cron from 'cron';

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const PRICE_THRESHOLD = parseFloat(process.env.PRICE_THRESHOLD) || 250;

const API_URL = "https://www.flylevel.com/nwe/flights/api/calendar/?triptype=RT&origin=EZE&destination=BCN&month=03&year=2026&currencyCode=USD";

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: false });

let initialized = false;
let ultimaConsultaConOfertas = null;

const sendMessage = async (message) => {
  try {
    await bot.sendMessage(TELEGRAM_CHAT_ID, message, { parse_mode: 'Markdown' });
  } catch (err) {
    console.error("❌ Error enviando mensaje:", err.message);
  }
};

const fetchFlightData = async () => {
  try {
    const res = await fetch(API_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = await res.json();
    if (!Array.isArray(data.vuelos)) throw new Error("Formato inesperado (no hay array 'vuelos')");

    const ofertas = data.vuelos.filter(vuelo => vuelo.precio < PRICE_THRESHOLD);

    if (!initialized) {
      initialized = true;
      await sendMessage("🚀 *Bot de vuelos iniciado correctamente.*");
    }

    if (ofertas.length > 0 && ultimaConsultaConOfertas !== JSON.stringify(ofertas)) {
      ultimaConsultaConOfertas = JSON.stringify(ofertas);
      for (const vuelo of ofertas) {
        await sendMessage(`🔔 *¡Oferta encontrada!*\n📅 Fecha: ${vuelo.fecha}\n💵 Precio: $${vuelo.precio}`);
      }
    } else {
      console.log("Sin ofertas nuevas por debajo del umbral.");
    }

  } catch (err) {
    console.error("❌ Error al consultar la API:", err.message);
  }
};

const job = new cron.CronJob('*/2 * * * *', fetchFlightData, null, true, 'America/Argentina/Buenos_Aires');

console.log("🟢 Servicio de bot iniciado.");
