// server.js
// API para consultar procesos judiciales en Rama Judicial Colombia
// Con sistema de jobs asíncronos para evitar timeouts

const express = require("express");
const cors = require("cors");
const { chromium } = require("playwright");

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", true);

app.use(express.json({ limit: "1mb" }));

// ================== CORS ==================
app.use(cors({ origin: "*", methods: ["GET"], allowedHeaders: ["Content-Type"] }));

// ================== SISTEMA DE JOBS ==================
const jobs = new Map(); // { jobId: { status, result, error, createdAt } }

function createJob(numeroRadicacion) {
  const jobId = `job_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  jobs.set(jobId, {
    status: "processing",
    numero_radicacion: numeroRadicacion,
    result: null,
    error: null,
    createdAt: new Date(),
  });
  return jobId;
}

function updateJob(jobId, updates) {
  const job = jobs.get(jobId);
  if (job) {
    jobs.set(jobId, { ...job, ...updates });
  }
}

// Limpiar jobs viejos cada 10 minutos
setInterval(() => {
  const now = Date.now();
  for (const [jobId, job] of jobs.entries()) {
    if (now - job.createdAt.getTime() > 600000) { // 10 minutos
      jobs.delete(jobId);
    }
  }
}, 600000);

// ================== HEALTH ==================
app.get("/", (_req, res) =>
  res.json({
    message: "API Rama Judicial Colombia",
    version: "3.0",
    endpoints: {
      "/health": "Estado de la API",
      "/buscar?numero_radicacion=XXXXX": "Iniciar búsqueda (devuelve jobId)",
      "/resultado/:jobId": "Consultar resultado de búsqueda",
    },
  })
);

app.get("/health", (_req, res) =>
  res.json({ 
    status: "ok", 
    service: "Rama Judicial Scraper",
    active_jobs: jobs.size 
  })
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

// ================== SCRAPING ==================
async function consultaRama(numeroProceso, jobId = null) {
  const url = "https://consultaprocesos.ramajudicial.gov.co/Procesos/NumeroRadicacion";
  const soloDigitos = numeroProceso.replace(/\D/g, "");

  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    console.log("[scraping] 1. Navegando...");
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });

    console.log("[scraping] 2. Llenando input...");
    await page.fill(
      "input[placeholder='Ingrese los 23 dígitos del número de Radicación']",
      soloDigitos
    );

    console.log("[scraping] 3. Consultando...");
    await page.click("button:has-text('Consultar')");
    
    await Promise.race([
      page.waitForSelector(`text=${soloDigitos}`, { timeout: 10000 }),
      page.waitForSelector("text=La consulta no generó resultados", { timeout: 10000 }),
    ]);

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
    await page.click(`text=${soloDigitos}`);
    await page.waitForSelector("tbody", { timeout: 10000 });

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

    // ================== SUJETOS PROCESALES ==================
    console.log("[scraping] 6. Extrayendo sujetos procesales...");
    
    let sujetosProcesales = [];
    try {
      await page.click('div.v-tab:has-text("Sujetos Procesales")');
      await page.waitForSelector('table tbody tr', { timeout: 5000 });
      
      const todasLasFilas = await page.locator('table tbody tr').all();
      
      for (const fila of todasLasFilas) {
        const celdas = await fila.locator('td').all();
        
        if (celdas.length === 2) {
          const tipo = await celdas[0].innerText().catch(() => "");
          const nombre = await celdas[1].innerText().catch(() => "");
          
          const tipoLimpio = tipo.trim();
          const nombreLimpio = nombre.trim();
          
          if ((tipoLimpio === 'Demandante' || tipoLimpio === 'Demandado') && nombreLimpio) {
            sujetosProcesales.push({
              tipo: tipoLimpio,
              nombre: nombreLimpio,
            });
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
      await page.waitForSelector('table tbody tr', { timeout: 5000 });
      
      const todasLasFilasAct = await page.locator('table tbody tr').all();

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

  } catch (error) {
    console.error("[scraping] ❌ Error:", error.message);
    throw error;
  } finally {
    await page.close();
  }
}

// ================== ENDPOINTS ==================

// Iniciar búsqueda (devuelve jobId inmediatamente)
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

  // Crear job y devolver inmediatamente
  const jobId = createJob(soloDigitos);
  console.log(`[job] 🆕 Creado: ${jobId} para ${radicado}`);

  // Iniciar scraping en background
  consultaRama(radicado, jobId)
    .then(resultado => {
      console.log(`[job] ✅ Completado: ${jobId}`);
      updateJob(jobId, { 
        status: "completed", 
        result: resultado 
      });
    })
    .catch(error => {
      console.error(`[job] ❌ Error: ${jobId}`, error);
      updateJob(jobId, { 
        status: "failed", 
        error: error.message 
      });
    });

  // Responder inmediatamente con el jobId
  res.json({
    success: true,
    jobId: jobId,
    numero_radicacion: soloDigitos,
    status: "processing",
    message: "Búsqueda iniciada. Use /resultado/:jobId para consultar el resultado.",
    poll_url: `/resultado/${jobId}`
  });
});

// Consultar resultado de un job
app.get("/resultado/:jobId", (req, res) => {
  const { jobId } = req.params;
  const job = jobs.get(jobId);

  if (!job) {
    return res.status(404).json({
      success: false,
      error: "Job no encontrado o expirado"
    });
  }

  if (job.status === "processing") {
    return res.json({
      success: true,
      jobId: jobId,
      status: "processing",
      numero_radicacion: job.numero_radicacion,
      message: "La búsqueda está en proceso. Consulte nuevamente en unos segundos."
    });
  }

  if (job.status === "completed") {
    return res.json({
      success: true,
      jobId: jobId,
      status: "completed",
      ...job.result
    });
  }

  if (job.status === "failed") {
    return res.status(500).json({
      success: false,
      jobId: jobId,
      status: "failed",
      error: job.error
    });
  }
});

// ================== START ==================
const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  console.log(`🚀 API Rama Judicial escuchando en puerto ${PORT}`);
});

server.requestTimeout = 120000;
server.headersTimeout = 120000;