// server.js
// API para consultar procesos judiciales en Rama Judicial Colombia

const express = require("express");
const cors = require("cors");
const { chromium } = require("playwright");

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", true);

app.use(express.json({ limit: "1mb" }));

// CORS
const corsOptions = {
  origin: "*",
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type"],
};
app.use(cors(corsOptions));
app.options("*", cors(corsOptions));

// Health checks
app.get("/", (_req, res) => res.json({ 
  message: "API Rama Judicial Colombia",
  version: "2.0 - Node.js",
  endpoints: {
    "/health": "Estado de la API",
    "/buscar": "GET - Buscar proceso por número de radicación"
  }
}));

app.get("/health", (_req, res) => res.json({ status: "ok", service: "Rama Judicial Scraper" }));

// ===============================================
//   Browser Singleton (lanzar una sola vez)
// ===============================================
let browserPromise = null;

async function getBrowser() {
  if (!browserPromise) {
    console.log("[boot] Lanzando Chromium...");
    browserPromise = chromium
      .launch({
        channel: "chromium",
        headless: true,
        args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
      })
      .then((b) => {
        console.log("[boot] ✅ Chromium listo");
        return b;
      })
      .catch((err) => {
        console.error("[boot] ❌ Error al lanzar Chromium:", err);
        browserPromise = null;
        throw err;
      });
  }
  return browserPromise;
}

// ===============================================
//   Función de scraping (traducción exacta de Python)
// ===============================================
async function consultaRama(numeroProceso) {
  const url = "https://consultaprocesos.ramajudicial.gov.co/Procesos/NumeroRadicacion";
  const soloDigitos = numeroProceso.replace(/\D/g, ""); // equiv a filter(str.isdigit)
  
  const browser = await getBrowser();
  const page = await browser.newPage();
  
  try {
    // 1. Navegar a la página
    await page.goto(url);
    
    // 2. Llenar input
    await page.fill(
      "input[placeholder='Ingrese los 23 dígitos del número de Radicación']",
      soloDigitos
    );
    
    // 3. Click en Consultar
    await page.click("button:has-text('Consultar')");
    
    // 4. Esperar y hacer click en el resultado
    await page.waitForSelector(`button:has-text('${soloDigitos}')`);
    await page.click(`button:has-text('${soloDigitos}')`);
    
    // 5. Extraer ficha del proceso
    await page.waitForSelector("tbody");
    const ficha = {};
    
    const filas = await page.locator("//tbody[.//th[contains(text(), 'Fecha de Radicación')]]//tr").all();
    
    for (const fila of filas) {
      const th = await fila.locator("th").first();
      const td = await fila.locator("td").first();
      
      const thText = await th.innerText().catch(() => null);
      const tdText = await td.innerText().catch(() => null);
      
      if (thText && tdText) {
        const key = thText.replace(":", "").trim();
        ficha[key] = tdText.trim();
      }
    }
    
    // 6. Click en pestaña Actuaciones
    await page.click("div.v-tab:has-text('Actuaciones')");
    await page.waitForTimeout(1500);
    
    // 7. Extraer actuaciones
    const actuaciones = [];
    const filasAct = await page.locator("//table//tbody/tr").all();
    
    for (const fila of filasAct) {
      const cols = await fila.locator("td").all();
      
      if (cols.length >= 6) {
        actuaciones.push({
          "Fecha de Actuación": await cols[0].innerText().catch(() => "").then(t => t.trim()),
          "Actuación": await cols[1].innerText().catch(() => "").then(t => t.trim()),
          "Anotación": await cols[2].innerText().catch(() => "").then(t => t.trim()),
          "Fecha inicia Término": await cols[3].innerText().catch(() => "").then(t => t.trim()),
          "Fecha finaliza Término": await cols[4].innerText().catch(() => "").then(t => t.trim()),
          "Fecha de Registro": await cols[5].innerText().catch(() => "").then(t => t.trim()),
        });
      }
    }
    
    return {
      success: true,
      proceso: ficha,
      actuaciones: actuaciones,
      total_actuaciones: actuaciones.length,
      ultima_actuacion: actuaciones[0] || null
    };
    
  } finally {
    await page.close();
  }
}

// ===============================================
//   Endpoint principal: GET /buscar
// ===============================================
app.get("/buscar", async (req, res) => {
  const numeroRadicacion = req.query.numero_radicacion;
  
  if (!numeroRadicacion) {
    return res.status(400).json({ 
      success: false,
      error: "Parámetro numero_radicacion requerido" 
    });
  }

  // Validar que tenga 23 dígitos
  const soloDigitos = numeroRadicacion.replace(/\D/g, "");
  if (soloDigitos.length !== 23) {
    return res.status(400).json({
      success: false,
      error: `El número debe tener 23 dígitos. Recibido: ${soloDigitos.length}`
    });
  }

  // Consultar
  try {
    console.log(`[consulta] Iniciando: ${numeroRadicacion}`);
    const resultado = await consultaRama(numeroRadicacion);
    console.log(`[consulta] ✅ Exitosa: ${resultado.total_actuaciones} actuaciones`);
    res.json(resultado);
  } catch (error) {
    console.error(`[consulta] ❌ Error:`, error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ===============================================
//   Iniciar servidor
// ===============================================
const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  console.log(`🚀 API Rama Judicial escuchando en puerto ${PORT}`);
});

// Timeouts largos para scraping
server.requestTimeout = 120000;  // 2 minutos
server.headersTimeout = 120000;  // 2 minutos