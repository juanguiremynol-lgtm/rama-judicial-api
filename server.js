// server.js
// API para consultar procesos judiciales en Rama Judicial Colombia
const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const { chromium } = require("playwright");

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", true);
app.use(express.json({ limit: "1mb" }));
app.use(cors({ origin: "*", methods: ["GET"], allowedHeaders: ["Content-Type"] }));

// ================== HEALTH ==================
app.get("/", (_req, res) =>
  res.json({
    message: "API Rama Judicial Colombia",
    version: "2.3",
    endpoints: {
      "/health": "Estado de la API",
      "/buscar?numero_radicacion=XXXXX": "Inicia job async y retorna job_id (202)",
      "/resultado/:job_id": "Consulta el estado/resultado del job",
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
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    });
  }
  return browserPromise;
}

// ================== CONCURRENCY (SEMAPHORE) ==================
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT || "2", 10);
let active = 0;
const queue = [];

async function withSemaphore(fn) {
  if (active >= MAX_CONCURRENT) {
    await new Promise((resolve) => queue.push(resolve));
  }
  active++;
  try {
    return await fn();
  } finally {
    active--;
    if (queue.length) queue.shift()();
  }
}

// ================== JOB STORE (IN-MEMORY) ==================
/**
 * Nota: Esto funciona bien en 1 instancia (un solo servidor).
 * Si vas a escalar horizontalmente (varias instancias), migra jobs/cache a Redis o DB.
 */
const JOB_TTL_MS = 5 * 60 * 1000; // 5 min
const jobs = new Map();

// Cache por radicado (opcional)
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 min
const cache = new Map();

function now() {
  return Date.now();
}

function cleanupMaps() {
  const t = now();

  // limpiar jobs
  for (const [id, job] of jobs.entries()) {
    if (t - job.createdAt > JOB_TTL_MS) jobs.delete(id);
  }

  // limpiar cache
  for (const [rad, item] of cache.entries()) {
    if (t - item.createdAt > CACHE_TTL_MS) cache.delete(rad);
  }
}

// cleanup periódico
setInterval(cleanupMaps, 30 * 1000).unref();

function newJobId() {
  return crypto.randomBytes(16).toString("hex");
}

// ================== SCRAPING ==================
async function consultaRama(numeroProceso) {
  const url = "https://consultaprocesos.ramajudicial.gov.co/Procesos/NumeroRadicacion";
  const soloDigitos = numeroProceso.replace(/\D/g, "");

  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    // Acelerar: bloquear recursos pesados
    await page.route("**/*", (route) => {
      const type = route.request().resourceType();
      if (["image", "media", "font"].includes(type)) return route.abort();
      return route.continue();
    });

    page.setDefaultTimeout(15000);

    console.log("[scraping] 1. Navegando...");
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });

    console.log("[scraping] 2. Llenando input...");
    await page.fill(
      "input[placeholder='Ingrese los 23 dígitos del número de Radicación']",
      soloDigitos
    );

    console.log("[scraping] 3. Consultando...");
    await page.click("button:has-text('Consultar')");

    // Esperar “resultado” o “no resultados” sin sleeps fijos
    const noResLocator = page.locator("text=La consulta no generó resultados");
    const resLocator = page.locator(`text=${soloDigitos}`).first();

    const outcome = await Promise.race([
      noResLocator.waitFor({ state: "visible", timeout: 15000 }).then(() => "NO_RES"),
      resLocator.waitFor({ state: "visible", timeout: 15000 }).then(() => "OK"),
    ]).catch(() => "TIMEOUT");

    if (outcome === "NO_RES") {
      console.log("[scraping] ❌ No se encontraron resultados");
      return {
        success: false,
        estado: "NO_ENCONTRADO",
        mensaje: "La consulta no generó resultados en la Rama Judicial",
        numero_radicacion: soloDigitos,
      };
    }

    if (outcome !== "OK") {
      throw new Error("Timeout esperando resultado o mensaje de no-resultados");
    }

    console.log("[scraping] 4. Abriendo resultado...");
    await page.click(`text=${soloDigitos}`);
    await page.waitForSelector("tbody", { timeout: 15000 });

    // ================== FICHA DEL PROCESO ==================
    console.log("[scraping] 5. Extrayendo ficha...");
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

    // Helper: scope a tabla al tab activo (evita leer tablas “ocultas”)
    const activeTableRows = () => page.locator(".v-window-item--active table tbody tr");

    // ================== SUJETOS PROCESALES ==================
    console.log("[scraping] 6. Extrayendo sujetos procesales...");
    let sujetosProcesales = [];
    try {
      await page.click('div.v-tab:has-text("Sujetos Procesales")');
      await activeTableRows().first().waitFor({ state: "visible", timeout: 8000 });

      const todasLasFilas = await activeTableRows().all();
      console.log(`[scraping] 📊 Total de filas (sujetos): ${todasLasFilas.length}`);

      for (const fila of todasLasFilas) {
        const celdas = await fila.locator("td").all();
        if (celdas.length === 2) {
          const tipo = (await celdas[0].innerText().catch(() => "")).trim();
          const nombre = (await celdas[1].innerText().catch(() => "")).trim();

          if ((tipo === "Demandante" || tipo === "Demandado") && nombre) {
            sujetosProcesales.push({ tipo, nombre });
          }
        }
      }

      console.log(`[scraping] ✅ Sujetos encontrados: ${sujetosProcesales.length}`);
    } catch (error) {
      console.log(`[scraping] ❌ Error extrayendo sujetos: ${error.message}`);
    }

    // ================== ACTUACIONES ==================
    console.log("[scraping] 7. Extrayendo actuaciones...");
    let actuaciones = [];
    try {
      await page.click('div.v-tab:has-text("Actuaciones")');
      await activeTableRows().first().waitFor({ state: "visible", timeout: 8000 });

      const todasLasFilasAct = await activeTableRows().all();
      console.log(`[scraping] 📊 Total de filas (actuaciones): ${todasLasFilasAct.length}`);

      for (const fila of todasLasFilasAct) {
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
    } catch (error) {
      console.log(`[scraping] ❌ Error extrayendo actuaciones: ${error.message}`);
    }

    return {
      success: true,
      numero_radicacion: soloDigitos,
      proceso: ficha,
      sujetos_procesales: sujetosProcesales,
      actuaciones: actuaciones,
      total_actuaciones: actuaciones.length,
      ultima_actuacion: actuaciones[0] || null,
    };
  } finally {
    await page.close();
  }
}

// ================== ENDPOINT ASYNC ==================
app.get("/buscar", async (req, res) => {
  const radicado = req.query.numero_radicacion;

  if (!radicado) {
    return res.status(400).json({
      success: false,
      error: "Parámetro numero_radicacion requerido",
    });
  }

  const soloDigitos = radicado.replace(/\D/g, "");
  if (soloDigitos.length !== 23) {
    return res.status(400).json({
      success: false,
      error: `El número debe tener 23 dígitos. Recibido: ${soloDigitos.length}`,
    });
  }

  // 1) Cache (si está fresco, responde de una)
  const cached = cache.get(soloDigitos);
  if (cached && now() - cached.createdAt <= CACHE_TTL_MS) {
    return res.json({
      ...cached.data,
      cached: true,
      cache_age_ms: now() - cached.createdAt,
    });
  }

  // 2) Crear job y responder rápido
  const jobId = newJobId();
  jobs.set(jobId, {
    id: jobId,
    estado: "EN_PROCESO",
    createdAt: now(),
    radicado: soloDigitos,
    result: null,
    error: null,
  });

  // Respuesta inmediata (Lovable no se queda esperando)
  res.status(202).json({
    success: true,
    estado: "EN_PROCESO",
    job_id: jobId,
    numero_radicacion: soloDigitos,
    poll: `/resultado/${jobId}`,
  });

  // 3) Ejecutar scraping “por detrás” (con control de concurrencia)
  setImmediate(async () => {
    try {
      console.log(`[job ${jobId}] 🔍 Iniciando scraping ${soloDigitos}`);
      const data = await withSemaphore(() => consultaRama(soloDigitos));

      // guardar cache si fue exitoso o incluso si NO_ENCONTRADO (a tu criterio)
      cache.set(soloDigitos, { createdAt: now(), data });

      const job = jobs.get(jobId);
      if (job) {
        job.estado = "COMPLETADO";
        job.result = data;
      }
      console.log(`[job ${jobId}] ✅ Completado`);
    } catch (e) {
      const job = jobs.get(jobId);
      if (job) {
        job.estado = "ERROR";
        job.error = e.message || String(e);
      }
      console.log(`[job ${jobId}] ❌ Error: ${e.message}`);
    }
  });
});

// ================== ENDPOINT POLLING ==================
app.get("/resultado/:job_id", (req, res) => {
  const jobId = req.params.job_id;
  const job = jobs.get(jobId);

  if (!job) {
    return res.status(404).json({
      success: false,
      estado: "NO_EXISTE",
      error: "job_id no encontrado o expirado",
    });
  }

  if (job.estado === "EN_PROCESO") {
    return res.status(202).json({
      success: true,
      estado: "EN_PROCESO",
      job_id: jobId,
      numero_radicacion: job.radicado,
      age_ms: now() - job.createdAt,
    });
  }

  if (job.estado === "ERROR") {
    return res.status(500).json({
      success: false,
      estado: "ERROR",
      job_id: jobId,
      numero_radicacion: job.radicado,
      error: job.error,
    });
  }

  // COMPLETADO
  return res.json({
    success: true,
    estado: "COMPLETADO",
    job_id: jobId,
    numero_radicacion: job.radicado,
    data: job.result,
  });
});

// ================== START ==================
const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  console.log(`🚀 API Rama Judicial escuchando en puerto ${PORT}`);
});

server.requestTimeout = 120000;
server.headersTimeout = 120000;
