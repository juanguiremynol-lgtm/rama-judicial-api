// server.js v4.1
// API Rama Judicial Colombia - Producción Completa
// ✅ Click en "Todos los Procesos" 
// ✅ Extracción completa: Ficha + Sujetos + Actuaciones
// ✅ Validaciones robustas + Graceful shutdown

const express = require("express");
const cors = require("cors");
const { chromium } = require("playwright");

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", true);

app.use(express.json({ limit: "1mb" }));
app.use(cors({ origin: "*", methods: ["GET"], allowedHeaders: ["Content-Type"] }));

/* =========================================================
   SISTEMA DE JOBS Y COLA
========================================================= */
const jobs = new Map();
const queue = [];
let activeJobs = 0;

const MAX_CONCURRENT_JOBS = 2;
const JOB_TTL_MS = 10 * 60 * 1000; // 10 minutos
const JOB_TIMEOUT_MS = 90 * 1000; // 90 segundos por job

function createJob(numeroRadicacion) {
  const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  jobs.set(jobId, {
    status: "queued",
    numero_radicacion: numeroRadicacion,
    result: null,
    error: null,
    createdAt: Date.now(),
  });
  return jobId;
}

function updateJob(jobId, data) {
  if (jobs.has(jobId)) {
    jobs.set(jobId, { ...jobs.get(jobId), ...data });
  }
}

async function processQueue() {
  if (activeJobs >= MAX_CONCURRENT_JOBS || queue.length === 0) return;

  const { jobId, numeroRadicacion } = queue.shift();
  activeJobs++;

  updateJob(jobId, { status: "processing" });
  console.log(`[queue] ⚙️ Procesando ${jobId} (${activeJobs}/${MAX_CONCURRENT_JOBS})`);

  try {
    // Timeout promise para evitar jobs colgados
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Job timeout (90s)")), JOB_TIMEOUT_MS)
    );

    const result = await Promise.race([
      consultaRama(numeroRadicacion, jobId),
      timeoutPromise,
    ]);

    console.log(`[queue] ✅ Completado ${jobId}`);
    updateJob(jobId, { status: "completed", result });
  } catch (err) {
    console.error(`[queue] ❌ Error ${jobId}:`, err.message);
    updateJob(jobId, { status: "failed", error: err.message });
  } finally {
    activeJobs--;
    processQueue();
  }
}

// Limpieza automática de jobs viejos
setInterval(() => {
  const now = Date.now();
  for (const [jobId, job] of jobs.entries()) {
    if (now - job.createdAt > JOB_TTL_MS) {
      console.log(`[cleanup] 🗑️ Eliminando job expirado: ${jobId}`);
      jobs.delete(jobId);
    }
  }
}, JOB_TTL_MS);

/* =========================================================
   HEALTH ENDPOINTS
========================================================= */
app.get("/", (_req, res) => {
  res.json({
    message: "API Rama Judicial Colombia",
    version: "4.1",
    features: [
      "✅ Extracción de ficha del proceso",
      "✅ Sujetos procesales (demandantes/demandados)",
      "✅ Todas las actuaciones del proceso",
      "✅ Sistema de jobs con timeout y rate limiting",
    ],
    endpoints: {
      "/health": "Estado de la API",
      "/buscar?numero_radicacion=XXXXX": "Inicia búsqueda",
      "/resultado/:jobId": "Consulta resultado",
    },
  });
});

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    active_jobs: activeJobs,
    queued_jobs: queue.length,
    total_jobs: jobs.size,
    uptime_seconds: Math.floor(process.uptime()),
  });
});

/* =========================================================
   BROWSER SINGLETON
========================================================= */
let browserPromise = null;

async function getBrowser() {
  if (!browserPromise) {
    console.log("[boot] 🚀 Lanzando Chromium (headless)");
    browserPromise = chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--disable-software-rasterizer",
      ],
    });
  }
  return browserPromise;
}

/* =========================================================
   SCRAPING COMPLETO
========================================================= */
async function consultaRama(numeroProceso, jobId) {
  const url = "https://consultaprocesos.ramajudicial.gov.co/Procesos/NumeroRadicacion";
  const soloDigitos = numeroProceso.replace(/\D/g, "");

  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    console.log(`[scraping ${jobId}] 1️⃣ Navegando a Rama Judicial...`);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 40000 });

    // ========== PASO CRÍTICO: Click en "Todos los Procesos" ==========
    console.log(`[scraping ${jobId}] 2️⃣ Activando "Todos los Procesos"...`);
    await page.waitForSelector('label:has-text("Todos los Procesos")', { timeout: 15000 });
    await page.click('label:has-text("Todos los Procesos")');
    
    // Esperar a que el input esté disponible después del click
    await page.waitForSelector('input[placeholder*="23 dígitos"]:not([disabled])', { 
      timeout: 5000 
    });

    // ========== Llenar formulario ==========
    console.log(`[scraping ${jobId}] 3️⃣ Ingresando número de radicación...`);
    await page.fill('input[placeholder*="23 dígitos"]', soloDigitos);

    console.log(`[scraping ${jobId}] 4️⃣ Consultando...`);
    await page.click('button:has-text("Consultar")');

    // Esperar resultado o mensaje de "no encontrado"
    await Promise.race([
      page.waitForSelector(`text=${soloDigitos}`, { timeout: 20000 }),
      page.waitForSelector("text=La consulta no generó resultados", { timeout: 20000 }),
    ]);

    const noResultados = await page.locator("text=La consulta no generó resultados").count();
    if (noResultados > 0) {
      console.log(`[scraping ${jobId}] ❌ NO ENCONTRADO`);
      return {
        success: false,
        found: false,
        estado: "NO_ENCONTRADO",
        numero_radicacion: soloDigitos,
        mensaje: "La consulta no generó resultados en la Rama Judicial",
      };
    }

    // ========== Abrir detalle del proceso ==========
    console.log(`[scraping ${jobId}] 5️⃣ Abriendo detalle del proceso...`);
    await page.click(`text=${soloDigitos}`);
    await page.waitForSelector("tbody", { timeout: 15000 });

    /* ================== FICHA DEL PROCESO ================== */
    console.log(`[scraping ${jobId}] 6️⃣ Extrayendo ficha del proceso...`);
    const ficha = {};
    const filas = await page
      .locator("//tbody[.//th[contains(text(),'Fecha de Radicación')]]//tr")
      .all();

    for (const fila of filas) {
      const th = await fila.locator("th").innerText().catch(() => null);
      const td = await fila.locator("td").innerText().catch(() => null);
      if (th && td) {
        ficha[th.replace(":", "").trim()] = td.trim();
      }
    }
    console.log(`[scraping ${jobId}] ✅ Ficha extraída: ${Object.keys(ficha).length} campos`);

    /* ================== SUJETOS PROCESALES ================== */
  console.log(`[scraping ${jobId}] 7️⃣ Extrayendo sujetos procesales...`);

let sujetosProcesales = [];
let sujetosEsperados = 0;

try {
  // 1. Activar pestaña
  await page.waitForSelector('div.v-tab:has-text("Sujetos Procesales")', {
    timeout: 15000,
  });
  await page.click('div.v-tab:has-text("Sujetos Procesales")');
  await page.waitForTimeout(800);

  // 2. Esperar tabla DE LA PESTAÑA ACTIVA (Vuetify)
  await page.waitForSelector(
    'div.v-window-item--active table tbody tr',
    { timeout: 15000 }
  );

  // 3. Leer "Resultados encontrados X"
  try {
    const textoResultados = await page
      .locator('span:has-text("Resultados encontrados")')
      .innerText();

    const match = textoResultados.match(/(\d+)/);
    if (match) {
      sujetosEsperados = parseInt(match[1], 10);
      console.log(
        `[scraping ${jobId}] 📊 Sujetos esperados según página: ${sujetosEsperados}`
      );
    }
  } catch {
    console.log(
      `[scraping ${jobId}] ⚠️ No se pudo leer contador de sujetos`
    );
  }

  // 4. Extraer filas y DEDUPLICAR
  const filas = await page
    .locator('div.v-window-item--active table tbody tr')
    .all();

  const vistos = new Set();

  for (const fila of filas) {
    const celdas = await fila.locator("td").all();
    if (celdas.length >= 2) {
      const tipo = (await celdas[0].innerText().catch(() => "")).trim();
      const nombre = (await celdas[1].innerText().catch(() => "")).trim();

      if (tipo && nombre) {
        const clave = `${tipo}||${nombre}`;
        if (!vistos.has(clave)) {
          vistos.add(clave);
          sujetosProcesales.push({ tipo, nombre });
        }
      }
    }
  }

  console.log(
    `[scraping ${jobId}] ✅ Sujetos únicos capturados: ${sujetosProcesales.length}`
  );

  // 5. Validación
  if (sujetosEsperados > 0 && sujetosProcesales.length !== sujetosEsperados) {
    console.log(
      `[scraping ${jobId}] ⚠️ ADVERTENCIA: Esperados ${sujetosEsperados}, capturados ${sujetosProcesales.length}`
    );
  } else if (sujetosEsperados > 0) {
    console.log(
      `[scraping ${jobId}] ✅ VERIFICADO: ${sujetosEsperados} sujetos completos`
    );
  }

} catch (error) {
  console.log(
    `[scraping ${jobId}] ❌ Error extrayendo sujetos procesales: ${error.message}`
  );
}
    /* ================== ACTUACIONES ================== */
    console.log(`[scraping ${jobId}] 8️⃣ Extrayendo actuaciones...`);
    let actuaciones = [];
    let resultadosEsperados = 0;

    try {
      await page.click('div.v-tab:has-text("Actuaciones")');
      await page.waitForSelector("table tbody tr", { timeout: 8000 });
      await page.waitForTimeout(1500); // Esperar carga completa de tabla

      // Extraer número de resultados esperados
      try {
        const textoResultados = await page
          .locator('span:has-text("Resultados encontrados")')
          .innerText();
        const match = textoResultados.match(/(\d+)/);
        if (match) {
          resultadosEsperados = parseInt(match[1]);
          console.log(`[scraping ${jobId}] 📊 Resultados esperados: ${resultadosEsperados}`);
        }
      } catch (error) {
        console.log(`[scraping ${jobId}] ⚠️ No se pudo leer contador de resultados`);
      }

      const todasLasFilasAct = await page.locator("table tbody tr").all();
      console.log(`[scraping ${jobId}] 📊 Total filas en tabla: ${todasLasFilasAct.length}`);

      for (const fila of todasLasFilasAct) {
        const cols = await fila.locator("td").all();

        // La tabla debe tener al menos 6 columnas
        if (cols.length >= 6) {
          const fecha = (await cols[0].innerText().catch(() => "")).trim();
          const actuacion = (await cols[1].innerText().catch(() => "")).trim();
          const anotacion = (await cols[2].innerText().catch(() => "")).trim();
          const fechaInicio = (await cols[3].innerText().catch(() => "")).trim();
          const fechaFin = (await cols[4].innerText().catch(() => "")).trim();
          const fechaRegistro = (await cols[5].innerText().catch(() => "")).trim();

          // ========== VALIDACIONES ROBUSTAS ==========
          // 1. Debe tener formato de fecha válido (YYYY-MM-DD)
          const esFechaValida = /^\d{4}-\d{2}-\d{2}$/.test(fecha);

          // 2. La actuación no debe estar vacía
          const tieneActuacion = actuacion.length > 0;

          // 3. NO debe ser encabezado de juzgado/tribunal
          const esEncabezadoJuzgado =
            actuacion.toUpperCase().includes("JUZGADO") ||
            actuacion.toUpperCase().includes("TRIBUNAL") ||
            actuacion.toUpperCase().includes("CORTE");

          // 4. NO debe ser encabezado de tabla
          const esEncabezadoTabla =
            actuacion.toUpperCase().includes("ACTUACIÓN") && !esFechaValida;

          if (esFechaValida && tieneActuacion && !esEncabezadoJuzgado && !esEncabezadoTabla) {
            actuaciones.push({
              fecha_actuacion: fecha,
              actuacion: actuacion,
              anotacion: anotacion || null,
              fecha_inicial_termino: fechaInicio || null,
              fecha_final_termino: fechaFin || null,
              fecha_registro: fechaRegistro || null,
            });
          }
        }
      }

      console.log(`[scraping ${jobId}] ✅ Actuaciones capturadas: ${actuaciones.length}`);

      // Validar cantidad
      if (resultadosEsperados > 0 && actuaciones.length !== resultadosEsperados) {
        console.log(
          `[scraping ${jobId}] ⚠️ ADVERTENCIA: Esperadas ${resultadosEsperados}, capturadas ${actuaciones.length}`
        );
      } else if (resultadosEsperados > 0) {
        console.log(
          `[scraping ${jobId}] ✅ VERIFICADO: ${resultadosEsperados} actuaciones completas`
        );
      }

      if (actuaciones.length === 0) {
        console.log(`[scraping ${jobId}] ⚠️ No se encontraron actuaciones válidas`);
      }
    } catch (error) {
      console.log(`[scraping ${jobId}] ⚠️ Error en actuaciones: ${error.message}`);
    }

    // ========== RESPUESTA COMPLETA ==========
 return {
  success: true,
  found: true,
  numero_radicacion: soloDigitos,
  proceso: ficha,
  sujetos_procesales: sujetosProcesales,
  actuaciones: actuaciones,
  estadisticas: {
    total_actuaciones: actuaciones.length,
    actuaciones_esperadas: resultadosEsperados,
    validacion_actuaciones:
      resultadosEsperados === 0 ||
      actuaciones.length === resultadosEsperados,

    total_sujetos: sujetosProcesales.length,
    sujetos_esperados: sujetosEsperados,
    validacion_sujetos:
      sujetosEsperados === 0 ||
      sujetosProcesales.length === sujetosEsperados,
  },
  ultima_actuacion: actuaciones[0] || null,
};
} finally {
  await page.close();
}
}

/* =========================================================
   ENDPOINTS
========================================================= */
app.get("/buscar", (req, res) => {
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

  const jobId = createJob(soloDigitos);
  queue.push({ jobId, numeroRadicacion: soloDigitos });

  console.log(`[job] 🆕 Creado ${jobId} - Cola: ${queue.length}`);

  processQueue();

  res.json({
    success: true,
    jobId,
    numero_radicacion: soloDigitos,
    status: "queued",
    queue_position: queue.length,
    poll_url: `/resultado/${jobId}`,
    message: "Búsqueda en cola. Consulte el resultado en unos segundos.",
  });
});

app.get("/resultado/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);

  if (!job) {
    return res.status(404).json({
      success: false,
      error: "Job no encontrado o expirado (TTL: 10 minutos)",
    });
  }

  if (job.status === "queued") {
    const position = queue.findIndex((q) => q.jobId === req.params.jobId) + 1;
    return res.json({
      success: true,
      jobId: req.params.jobId,
      status: "queued",
      queue_position: position,
      numero_radicacion: job.numero_radicacion,
      message: `En cola (posición ${position}). Consulte nuevamente en unos segundos.`,
    });
  }

  if (job.status === "processing") {
    return res.json({
      success: true,
      jobId: req.params.jobId,
      status: "processing",
      numero_radicacion: job.numero_radicacion,
      message: "Extrayendo información del proceso...",
    });
  }

  if (job.status === "completed") {
    return res.json({
      success: true,
      jobId: req.params.jobId,
      status: "completed",
      ...job.result,
    });
  }

  if (job.status === "failed") {
    return res.status(500).json({
      success: false,
      jobId: req.params.jobId,
      status: "failed",
      error: job.error,
    });
  }
});

/* =========================================================
   GRACEFUL SHUTDOWN
========================================================= */
async function shutdown(signal) {
  console.log(`\n[shutdown] Recibido ${signal}, cerrando servidor...`);

  // Cerrar browser
  if (browserPromise) {
    try {
      const browser = await browserPromise;
      await browser.close();
      console.log("[shutdown] ✅ Browser cerrado");
    } catch (error) {
      console.error("[shutdown] ⚠️ Error cerrando browser:", error.message);
    }
  }

  // Cerrar servidor Express
  server.close(() => {
    console.log("[shutdown] ✅ Servidor HTTP cerrado");
    process.exit(0);
  });

  // Forzar cierre después de 10 segundos
  setTimeout(() => {
    console.error("[shutdown] ❌ Cierre forzado por timeout");
    process.exit(1);
  }, 10000);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

/* =========================================================
   START
========================================================= */
const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  console.log(`🚀 API Rama Judicial v4.1 activa en puerto ${PORT}`);
  console.log(`📊 Configuración:`);
  console.log(`   - Max jobs concurrentes: ${MAX_CONCURRENT_JOBS}`);
  console.log(`   - Timeout por job: ${JOB_TIMEOUT_MS / 1000}s`);
  console.log(`   - TTL de jobs: ${JOB_TTL_MS / 60000} minutos`);
});

server.requestTimeout = 120000;
server.headersTimeout = 120000;