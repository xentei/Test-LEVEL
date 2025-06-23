import fetch from 'node-fetch';
import TelegramBot from 'node-telegram-bot-api';
import { config } from 'dotenv';
import { CronJob } from 'cron';

config();

const token = process.env.TELEGRAM_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;
const threshold = parseFloat(process.env.PRICE_THRESHOLD);

const bot = new TelegramBot(token);

const apiUrl = 'https://www.flylevel.com/mwe/flights/api/calendar/?triptype=RT&origin=EZE&destination=BCN&outboundDate=2026-03-08&month=03&year=2026&currencyCode=USD';

let startupMessageSent = false;

async function checkPrices() {
  try {
    const res = await fetch(apiUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36",
        "Accept": "application/json",
        "Referer": "https://www.flylevel.com/Flight/select?culture=es-ES&triptype=RT&ol=EZE&dl=BCN&dd1=2026-03-08"
      }
    });

    const text = await res.text();
    let data;

    try {
      data = JSON.parse(text);
    } catch {
      console.error('❌ La respuesta no es JSON. Probablemente la API devolvió HTML o un error de autenticación.');
      return;
    }

    if (data?.data?.dayPrices) {
      for (let day of data.data.dayPrices) {
        if (day.price < threshold) {
          const msg = `📢 ¡Oferta encontrada!\n📅 Fecha: ${day.date}\n💲 Precio: $${day.price}`;
          await bot.sendMessage(chatId, msg);
        }
      }
    }

  } catch (err) {
    console.error('Error al consultar la API:', err.message);
  }
}

if (!startupMessageSent) {
  bot.sendMessage(chatId, '🚀 El bot de vuelos ha iniciado correctamente.');
  startupMessageSent = true;
}

const job = new CronJob('*/2 * * * *', checkPrices, null, true, 'America/Argentina/Buenos_Aires');
job.start();
