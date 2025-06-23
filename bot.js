import fetch from 'node-fetch';
import TelegramBot from 'node-telegram-bot-api';
import { config } from 'dotenv';
import { CronJob } from 'cron';

config(); // Carga variables de entorno

const token = process.env.TELEGRAM_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;
const threshold = parseFloat(process.env.PRICE_THRESHOLD);

const bot = new TelegramBot(token);
const apiUrl = 'https://www.flylevel.com/mwe/flights/api/calendar/?triptype=RT&origin=EZE&destination=BCN&outboundDate=2026-03-08&month=03&year=2026&currencyCode=USD';

let started = false; // Controla si ya se envió el mensaje de inicio

async function checkPrices() {
  try {
    if (!started) {
      await bot.sendMessage(chatId, '🚀 El bot de vuelos ha iniciado correctamente.');
      started = true;
    }

    const res = await fetch(apiUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
        'Accept': 'application/json',
        'Referer': 'https://www.flylevel.com/Flight/Select?culture=es-ES&triptype=RT&origin=EZE&destination=BCN&dd1=2026-03-08'
      }
    });

    const data = await res.json();

    if (data && data.data && data.data.dayPrices) {
      let ofertas = 0;
      for (let day of data.data.dayPrices) {
        if (day.price < threshold) {
          const date = day.date;
          const price = day.price;
          const msg = `📢 ¡Oferta encontrada!\n📅 Fecha: ${date}\n💵 Precio: $${price}`;
          await bot.sendMessage(chatId, msg);
          ofertas++;
        }
      }
      // No envía nada si no hay ofertas
    } else {
      console.error('No se encontró la estructura esperada en la respuesta de la API.');
    }
  } catch (err) {
    console.error('Error al consultar la API:', err.message);
  }
}

// Ejecutar cada 2 minutos
const job = new CronJob('*/2 * * * *', checkPrices, null, true, 'America/Argentina/Buenos_Aires');

// Mantener proceso activo para Railway
setInterval(() => {}, 1 << 30);
