// server.js
// API para consultar procesos judiciales en Rama Judicial Colombia

const express = require("express");
const cors = require("cors");
const { chromium } = require("playwright");

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", true);

app.use(express.json({ limit: "1mb" }));

// ================== CORS ==================
app.use(cors({ origin: "*", methods: ["GET"], allowedHeaders: ["Content-Type"] }));

// ================== HEALTH ==================
app.get("/", (_req, res) =>
  res.json({
    message: "API Rama Judicial Colombia",
    version: "2.2",
    endpoints: {
      "/health": "Estado de la API",
      "/buscar?numero_radicacion=XXXXX": "Buscar proceso",
    },
  })
);

app.get("/health", (_req, res) =>
  res.json({ status: "ok", service: "Rama Judicial Scraper" })
);

// ================== BROWSER SINGLETON ==================
let browserPromise = null;

async function getBrowser() {
  if (!browserPromise) {
    console.log("[boot] Lanzando Chromium...");
    browserPromise = chromium.launch({
      channel: "chromium",
      headless: true, // true en producción
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    });
  }
  return browserPromise;
}

// ================== SCRAPING ==================
async function consultaRama(numeroProceso) {
  const url = "https://consultaprocesos.ramajudicial.gov.co/Procesos/NumeroRadicacion";
  const soloDigitos = numeroProceso.replace(/\D/g, "");

  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    console.log("[scraping] 1. Navegando...");
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });

    console.log("[scraping] 2. Llenando input...");
    await page.fill(
      "input[placeholder='Ingrese los 23 dígitos del número de Radicación']",
      soloDigitos
    );

    console.log("[scraping] 3. Consultando...");
    await page.click("button:has-text('Consultar')");
    await page.waitForTimeout(2000);

    // 4. Verificar si NO hay resultados
    const noResultados = await page.locator("text=La consulta no generó resultados").count();
    if (noResultados > 0) {
      console.log("[scraping] ❌ No se encontraron resultados");
      return {
        success: false,
        estado: "NO_ENCONTRADO",
        mensaje: "La consulta no generó resultados en la Rama Judicial",
        numero_radicacion: soloDigitos,
      };
    }

    console.log("[scraping] 4. Abriendo resultado...");
    await page.waitForSelector(`text=${soloDigitos}`, { timeout: 15000 });
    await page.click(`text=${soloDigitos}`);
    await page.waitForTimeout(2000);

    // ================== FICHA DEL PROCESO ==================
    console.log("[scraping] 5. Extrayendo ficha...");
    await page.waitForSelector("tbody", { timeout: 15000 });
    const ficha = {};

    const filas = await page
      .locator("//tbody[.//th[contains(text(), 'Fecha de Radicación')]]//tr")
      .all();

    for (const fila of filas) {
      const th = await fila.locator("th").first().innerText().catch(() => null);
      const td = await fila.locator("td").first().innerText().catch(() => null);
      if (th && td) {
        ficha[th.replace(":", "").trim()] = td.trim();
      }
    }

    // ================== SUJETOS PROCESALES ==================
    console.log("[scraping] 6. Extrayendo sujetos procesales...");
    await page.click('div.v-tab:has-text("Sujetos Procesales")');
    await page.waitForTimeout(1500);

    // Esperar a que se cargue la tabla dentro de la pestaña activa
    await page.waitForSelector('div.v-tab-item--active table tbody tr', { timeout: 10000 });

    const sujetosProcesales = [];
    const filasSujetos = await page.locator('div.v-tab-item--active table tbody tr').all();

    for (const fila of filasSujetos) {
      const celdas = await fila.locator('td').all();
      if (celdas.length >= 2) {
        const tipo = await celdas[0].innerText().catch(() => "");
        const nombre = await celdas[1].innerText().catch(() => "");

        if (tipo.trim() && nombre.trim()) {
          sujetosProcesales.push({
            tipo: tipo.trim(),
            nombre: nombre.trim(),
          });
        }
      }
    }

    console.log(`[scraping] ✅ Sujetos encontrados: ${sujetosProcesales.length}`);

    // ================== ACTUACIONES ==================
    console.log("[scraping] 7. Extrayendo actuaciones...");
    await page.click('div.v-tab:has-text("Actuaciones")');
    await page.waitForTimeout(1500);

    await page.waitForSelector('div.v-tab-item--active table tbody tr', { timeout: 10000 });

    const actuaciones = [];
    const filasAct = await page.locator('div.v-tab-item--active table tbody tr').all();

    for (const fila of filasAct) {
      const cols = await fila.locator("td").all();
      if (cols.length >= 6) {
        actuaciones.push({
          "Fecha de Actuación": (await cols[0].innerText().catch(() => "")).trim(),
          "Actuación": (await cols[1].innerText().catch(() => "")).trim(),
          "Anotación": (await cols[2].innerText().catch(() => "")).trim(),
          "Fecha inicia Término": (await cols[3].innerText().catch(() => "")).trim(),
          "Fecha finaliza Término": (await cols[4].innerText().catch(() => "")).trim(),
          "Fecha de Registro": (await cols[5].innerText().catch(() => "")).trim(),
        });
      }
    }

    console.log(`[scraping] ✅ Actuaciones encontradas: ${actuaciones.length}`);

    // ================== RESULTADO FINAL ==================
    return {
      success: true,
      numero_radicacion: soloDigitos,
      proceso: ficha,
      sujetos_procesales: sujetosProcesales,
      actuaciones: actuaciones,
      total_actuaciones: actuaciones.length,
      ultima_actuacion: actuaciones[0] || null,
    };

  } catch (error) {
    console.error("[scraping] ❌ Error:", error.message);
    throw error;
  } finally {
    await page.close();
  }
}

// ================== ENDPOINT ==================
app.get("/buscar", async (req, res) => {
  const radicado = req.query.numero_radicacion;
  
  if (!radicado) {
    return res.status(400).json({ 
      success: false, 
      error: "Parámetro numero_radicacion requerido" 
    });
  }

  const soloDigitos = radicado.replace(/\D/g, "");
  if (soloDigitos.length !== 23) {
    return res.status(400).json({ 
      success: false, 
      error: `El número debe tener 23 dígitos. Recibido: ${soloDigitos.length}` 
    });
  }

  try {
    console.log(`[consulta] 🔍 Iniciando: ${radicado}`);
    const resultado = await consultaRama(radicado);
    console.log(`[consulta] ✅ Exitosa`);
    res.json(resultado);
  } catch (err) {
    console.error("[consulta] ❌ Error:", err);
    res.status(500).json({ 
      success: false, 
      error: err.message 
    });
  }
});

// ================== START ==================
const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  console.log(`🚀 API Rama Judicial escuchando en puerto ${PORT}`);
});

server.requestTimeout = 120000;  // 2 minutos
server.headersTimeout = 120000;  // 2 minutos
