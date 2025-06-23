import fetch from 'node-fetch';
import TelegramBot from 'node-telegram-bot-api';
import cron from 'cron';

// Configuración
const config = {
  telegramToken: process.env.TELEGRAM_TOKEN,
  chatId: process.env.TELEGRAM_CHAT_ID,
  priceThreshold: parseFloat(process.env.PRICE_THRESHOLD) || 250,
  apiUrl: "https://www.flylevel.com/nwe/flights/api/calendar/?triptype=RT&origin=EZE&destination=BCN&month=03&year=2026&currencyCode=USD",
  cronPattern: process.env.CRON_PATTERN || '*/2 * * * *', // Cada 2 minutos por defecto
  maxRetries: 3,
  retryDelay: 5000 // 5 segundos
};

// Validar configuración
const validateConfig = () => {
  const required = ['telegramToken', 'chatId'];
  const missing = required.filter(key => !config[key]);
  
  if (missing.length > 0) {
    throw new Error(`❌ Configuración faltante: ${missing.join(', ')}`);
  }
};

// Inicializar bot
const bot = new TelegramBot(config.telegramToken, { polling: false });

// Estado del bot
const botState = {
  initialized: false,
  lastCheck: null,
  totalChecks: 0,
  offersFound: 0,
  errors: 0,
  lastOffers: new Map() // Para evitar duplicados
};

// Función para enviar mensajes con reintentos
const sendMessage = async (message, retries = 0) => {
  try {
    await bot.sendMessage(config.chatId, message, { 
      parse_mode: 'Markdown',
      disable_web_page_preview: true 
    });
    console.log(`📤 Mensaje enviado: ${message.substring(0, 50)}...`);
  } catch (err) {
    console.error(`❌ Error enviando mensaje (intento ${retries + 1}):`, err.message);
    
    if (retries < config.maxRetries) {
      console.log(`🔄 Reintentando en ${config.retryDelay}ms...`);
      await new Promise(resolve => setTimeout(resolve, config.retryDelay));
      return sendMessage(message, retries + 1);
    }
    
    throw err;
  }
};

// Función para formatear fecha
const formatDate = (dateString) => {
  try {
    const date = new Date(dateString);
    return date.toLocaleDateString('es-AR', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric'
    });
  } catch {
    return dateString;
  }
};

// Función para generar ID único del vuelo
const getFlightId = (vuelo) => {
  return `${vuelo.fecha}_${vuelo.precio}`;
};

// Función para verificar si es una oferta duplicada
const isDuplicateOffer = (vuelo) => {
  const flightId = getFlightId(vuelo);
  const now = Date.now();
  const lastSeen = botState.lastOffers.get(flightId);
  
  // Considerar duplicado si se envió en las últimas 2 horas
  if (lastSeen && (now - lastSeen) < 2 * 60 * 60 * 1000) {
    return true;
  }
  
  botState.lastOffers.set(flightId, now);
  return false;
};

// Función para limpiar ofertas antiguas del cache
const cleanupOldOffers = () => {
  const now = Date.now();
  const maxAge = 24 * 60 * 60 * 1000; // 24 horas
  
  for (const [flightId, timestamp] of botState.lastOffers.entries()) {
    if (now - timestamp > maxAge) {
      botState.lastOffers.delete(flightId);
    }
  }
};

// Función principal para obtener datos de vuelos
const fetchFlightData = async () => {
  const startTime = Date.now();
  botState.totalChecks++;
  
  try {
    console.log(`🔍 Consulta #${botState.totalChecks} - ${new Date().toLocaleString('es-AR')}`);
    
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000); // 30s timeout
    
    const res = await fetch(config.apiUrl, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; FlightBot/1.0)',
        'Accept': 'application/json'
      }
    });
    
    clearTimeout(timeoutId);
    
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    }
    
    const data = await res.json();
    
    // Validar estructura de datos
    if (!data || !Array.isArray(data.vuelos)) {
      throw new Error("Estructura de datos inválida en la respuesta de la API");
    }
    
    // Mensaje de inicialización
    if (!botState.initialized) {
      botState.initialized = true;
      await sendMessage(`🟢 *Bot iniciado correctamente*\n\n📊 Configuración:\n• Umbral de precio: $${config.priceThreshold}\n• Frecuencia: cada 2 minutos\n• Ruta: EZE → BCN\n\n🔍 Monitoreando vuelos...`);
    }
    
    // Filtrar ofertas
    const ofertas = data.vuelos.filter(v => 
      v.precio && 
      v.precio < config.priceThreshold && 
      !isDuplicateOffer(v)
    );
    
    // Procesar ofertas
    if (ofertas.length > 0) {
      botState.offersFound += ofertas.length;
      
      for (const vuelo of ofertas) {
        const mensaje = `✈️ *¡OFERTA ENCONTRADA!*\n\n` +
          `📅 *Fecha:* ${formatDate(vuelo.fecha)}\n` +
          `💰 *Precio:* $${vuelo.precio} USD\n` +
          `🎯 *Ahorro:* $${(config.priceThreshold - vuelo.precio).toFixed(2)}\n` +
          `🛫 *Ruta:* Buenos Aires → Barcelona\n\n` +
          `_Consulta #${botState.totalChecks}_`;
        
        await sendMessage(mensaje);
        
        // Pequeña pausa entre mensajes
        if (ofertas.length > 1) {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }
      
      console.log(`🎉 ${ofertas.length} ofertas encontradas y enviadas`);
    } else {
      console.log(`ℹ️ No se encontraron ofertas (${data.vuelos.length} vuelos consultados)`);
    }
    
    botState.lastCheck = new Date();
    
    // Limpiar cache antiguo cada 100 consultas
    if (botState.totalChecks % 100 === 0) {
      cleanupOldOffers();
      console.log(`🧹 Cache limpiado en consulta #${botState.totalChecks}`);
    }
    
    const duration = Date.now() - startTime;
    console.log(`✅ Consulta completada en ${duration}ms`);
    
  } catch (err) {
    botState.errors++;
    console.error(`❌ Error en consulta #${botState.totalChecks}:`, err.message);
    
    // Notificar errores críticos
    if (botState.errors % 10 === 0) {
      try {
        await sendMessage(`⚠️ *Advertencia*\n\nSe han producido ${botState.errors} errores consecutivos. El bot sigue funcionando pero revisa la configuración.\n\n_Último error: ${err.message}_`);
      } catch (notificationErr) {
        console.error("❌ No se pudo enviar notificación de error:", notificationErr.message);
      }
    }
  }
};

// Función para enviar estadísticas
const sendStats = async () => {
  const uptime = process.uptime();
  const hours = Math.floor(uptime / 3600);
  const minutes = Math.floor((uptime % 3600) / 60);
  
  const stats = `📊 *Estadísticas del Bot*\n\n` +
    `⏰ *Tiempo activo:* ${hours}h ${minutes}m\n` +
    `🔍 *Consultas realizadas:* ${botState.totalChecks}\n` +
    `🎯 *Ofertas encontradas:* ${botState.offersFound}\n` +
    `❌ *Errores:* ${botState.errors}\n` +
    `🕐 *Última consulta:* ${botState.lastCheck?.toLocaleString('es-AR') || 'Nunca'}\n` +
    `💰 *Umbral actual:* $${config.priceThreshold}`;
  
  await sendMessage(stats);
};

// Configurar cron job principal
const mainJob = new cron.CronJob(
  config.cronPattern, 
  fetchFlightData, 
  null, 
  false, // No iniciar automáticamente
  'America/Argentina/Buenos_Aires'
);

// Estadísticas diarias a las 20:00
const statsJob = new cron.CronJob(
  '0 20 * * *', 
  sendStats, 
  null, 
  false,
  'America/Argentina/Buenos_Aires'
);

// Función de inicialización
const init = async () => {
  try {
    console.log("🚀 Iniciando bot de vuelos...");
    
    // Validar configuración
    validateConfig();
    
    // Probar conexión con Telegram
    const botInfo = await bot.getMe();
    console.log(`🤖 Bot conectado: @${botInfo.username}`);
    
    // Iniciar jobs
    mainJob.start();
    statsJob.start();
    
    console.log(`✅ Bot iniciado correctamente`);
    console.log(`📊 Configuración:`);
    console.log(`   • Umbral de precio: $${config.priceThreshold}`);
    console.log(`   • Patrón cron: ${config.cronPattern}`);
    console.log(`   • Chat ID: ${config.chatId}`);
    console.log(`   • Zona horaria: America/Argentina/Buenos_Aires`);
    
    // Ejecutar primera consulta
    await fetchFlightData();
    
  } catch (err) {
    console.error("❌ Error al inicializar:", err.message);
    process.exit(1);
  }
};

// Manejo de señales para cierre graceful
process.on('SIGINT', () => {
  console.log('\n🛑 Cerrando bot...');
  mainJob.stop();
  statsJob.stop();
  sendMessage('🔴 *Bot detenido*\n\nEl monitoreo de vuelos se ha pausado.')
    .finally(() => process.exit(0));
});

process.on('uncaughtException', (err) => {
  console.error('❌ Error no capturado:', err);
  sendMessage(`🚨 *Error crítico*\n\n${err.message}`)
    .finally(() => process.exit(1));
});

// Iniciar el bot
init();
