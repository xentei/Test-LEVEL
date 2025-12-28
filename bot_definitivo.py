import os
import smtplib
import pandas as pd
import re
import sys
from email.mime.text import MIMEText
from datetime import datetime, timedelta
from playwright.sync_api import sync_playwright

# === TOMA LOS DATOS DE LA CONFIGURACIÓN DE GITHUB ===
MI_EMAIL = os.environ.get("GMAIL_USER")
MI_PASS_APP = os.environ.get("GMAIL_PASS")

PRECIO_OBJETIVO = 850    
DIAS_MIN_ESTADIA = 7     
DIAS_MAX_ESTADIA = 25    
ANIO = 2026              

def enviar_alerta(mejores_vuelos):
    print(f"📧 ¡ENCONTRÉ VUELOS! Enviando correo...")
    cuerpo = f"¡Hola! Vuelos encontrados por menos de {PRECIO_OBJETIVO} USD:\n\n"
    
    for index, row in mejores_vuelos.head(5).iterrows():
        linea = (f"✈️ {row['Salida']} -> {row['Regreso']} ({row['Días']}d) | 💰 {row['TOTAL']} USD\n")
        cuerpo += linea
    
    msg = MIMEText(cuerpo)
    msg['Subject'] = f"🚨 ALERTA VUELO: {mejores_vuelos.iloc[0]['TOTAL']} USD"
    msg['From'] = MI_EMAIL
    msg['To'] = MI_EMAIL

    try:
        server = smtplib.SMTP_SSL('smtp.gmail.com', 465)
        server.login(MI_EMAIL, MI_PASS_APP)
        server.send_message(msg)
        server.quit()
        print("✅ Correo enviado.")
    except Exception as e:
        print(f"❌ Error correo: {e}")

def buscar_tramo(origen, destino, anio):
    print(f"🔎 Buscando {origen}->{destino}...")
    resultados = []
    with sync_playwright() as p:
        # IMPORTANTE: headless=True para la nube
        browser = p.chromium.launch(headless=True) 
        page = browser.new_page()

        for mes in range(1, 13):
            fecha = datetime(anio, mes, 1)
            f_ida = fecha.strftime("%Y-%m-%d")
            f_vuelta = (fecha + timedelta(days=7)).strftime("%Y-%m-%d")
            
            # URL COMPLETA CON PARÁMETROS MAGICOS
            url = (f"https://www.flylevel.com/Flight/Select?o1={origen}&d1={destino}"
                   f"&dd1={f_ida}&dd2={f_vuelta}"
                   "&ADT=1&CHD=0&INL=0&r=true&mm=true&forcedCurrency=USD&forcedCulture=es-ES&newecom=true")
            
            datos_mes = []
            
            def interceptar(response):
                if "calendar" in response.url and response.status == 200:
                    try:
                        data = response.json()
                        lista = []
                        if isinstance(data, dict) and "data" in data:
                            lista = data["data"].get("dayPrices", [])
                        elif isinstance(data, list):
                            lista = data
                        for item in lista:
                            if item.get('price'):
                                datos_mes.append({"Fecha": item.get('date'), "Precio": item.get('price')})
                    except: pass

            page.on("response", interceptar)
            try:
                page.goto(url)
                if mes == 1: 
                    try: page.locator("button#onetrust-accept-btn-handler").click(timeout=3000)
                    except: pass
                page.wait_for_timeout(4000) # Espera red
                if datos_mes: resultados.extend(datos_mes)
            except: pass
            page.remove_listener("response", interceptar)
        
        browser.close()
    return pd.DataFrame(resultados)

def ejecutar_bot():
    print(f"🤖 INICIANDO - {datetime.now()}")
    if not MI_EMAIL or not MI_PASS_APP:
        print("❌ Error: No se configuraron las variables de entorno (Secretos).")
        return

    df_ida = buscar_tramo("EZE", "BCN", ANIO)
    df_vuelta = buscar_tramo("BCN", "EZE", ANIO)

    if df_ida.empty or df_vuelta.empty:
        print("❌ Sin datos suficientes.")
        return

    print("🧠 Analizando...")
    df_ida['Fecha_dt'] = pd.to_datetime(df_ida['Fecha'])
    df_vuelta['Fecha_dt'] = pd.to_datetime(df_vuelta['Fecha'])
    
    opciones = []
    for _, f_ida in df_ida.iterrows():
        salida = f_ida['Fecha_dt']
        ini, fin = salida + timedelta(days=DIAS_MIN_ESTADIA), salida + timedelta(days=DIAS_MAX_ESTADIA)
        vueltas = df_vuelta[(df_vuelta['Fecha_dt'] >= ini) & (df_vuelta['Fecha_dt'] <= fin)]
        
        for _, f_vuelta in vueltas.iterrows():
            total = f_ida['Precio'] + f_vuelta['Precio']
            if total <= PRECIO_OBJETIVO:
                opciones.append({
                    'Salida': f_ida['Fecha'], 'Regreso': f_vuelta['Fecha'],
                    'Días': (f_vuelta['Fecha_dt'] - salida).days, 'TOTAL': total
                })

    if opciones:
        df_final = pd.DataFrame(opciones).sort_values('TOTAL')
        print(f"🎉 ÉXITO: {df_final.iloc[0]['TOTAL']} USD")
        enviar_alerta(df_final)
    else:
        print("📉 Nada barato hoy.")

if __name__ == "__main__":
    ejecutar_bot()
