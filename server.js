// server.js
// API para consultar procesos judiciales en Rama Judicial Colombia
// Con sistema de jobs asíncronos y rate limiting

const express = require("express");
const cors = require("cors");
const { chromium } = require("playwright");

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", true);

app.use(express.json({ limit: "1mb" }));

// ================== CORS ==================
app.use(cors({ origin: "*", methods: ["GET"], allowedHeaders: ["Content-Type"] }));

// ================== SISTEMA DE JOBS Y QUEUE ==================
const jobs = new Map();
const queue = [];
let activeJobs = 0;
const MAX_CONCURRENT_JOBS = 2;

function createJob(numeroRadicacion) {
  const jobId = `job_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  jobs.set(jobId, {
    status: "queued",
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

async function processQueue() {
  if (activeJobs >= MAX_CONCURRENT_JOBS || queue.length === 0) {
    return;
  }

  const { jobId, numeroRadicacion } = queue.shift();
  activeJobs++;
  
  updateJob(jobId, { status: "processing" });
  console.log(`[queue] ⚙️ Procesando: ${jobId} (${activeJobs}/${MAX_CONCURRENT_JOBS})`);

  try {
    const resultado = await consultaRama(numeroRadicacion, jobId);
    console.log(`[queue] ✅ Completado: ${jobId}`);
    updateJob(jobId, { 
      status: "completed", 
      result: resultado 
    });
  } catch (error) {
    console.error(`[queue] ❌ Error: ${jobId}`, error);
    updateJob(jobId, { 
      status: "failed", 
      error: error.message 
    });
  } finally {
    activeJobs--;
    processQueue();
  }
}

setInterval(() => {
  const now = Date.now();
  for (const [jobId, job] of jobs.entries()) {
    if (now - job.createdAt.getTime() > 600000) {
      jobs.delete(jobId);
    }
  }
}, 600000);

// ================== HEALTH ==================
app.get("/", (_req, res) =>
  res.json({
    message: "API Rama Judicial Colombia",
    version: "3.2",
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
    active_jobs: activeJobs,
    queued_jobs: queue.length,
    total_jobs: jobs.size
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
      args: [
        "--no-sandbox", 
        "--disable-setuid-sandbox", 
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--disable-software-rasterizer"
      ],
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
    console.log(`[scraping ${jobId}] 1. Navegando...`);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 40000 });

    console.log(`[scraping ${jobId}] 2. Llenando input...`);
    await page.waitForSelector("input[placeholder*='23 dígitos']", { timeout: 15000 });
    await page.fill("input[placeholder*='23 dígitos']", soloDigitos);

    console.log(`[scraping ${jobId}] 3. Consultando...`);
    await page.click("button:has-text('Consultar')");
    
    await Promise.race([
      page.waitForSelector(`text=${soloDigitos}`, { timeout: 15000 }),
      page.waitForSelector("text=La consulta no generó resultados", { timeout: 15000 }),
    ]);

    const noResultados = await page.locator("text=La consulta no generó resultados").count();
    if (noResultados > 0) {
      console.log(`[scraping ${jobId}] ❌ No se encontraron resultados`);
      return {
        success: false,
        estado: "NO_ENCONTRADO",
        mensaje: "La consulta no generó resultados en la Rama Judicial",
        numero_radicacion: soloDigitos,
      };
    }

    console.log(`[scraping ${jobId}] 4. Abriendo resultado...`);
    await page.click(`text=${soloDigitos}`);
    await page.waitForSelector("tbody", { timeout: 15000 });

    // ================== FICHA DEL PROCESO ==================
    console.log(`[scraping ${jobId}] 5. Extrayendo ficha...`);
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
    console.log(`[scraping ${jobId}] 6. Extrayendo sujetos procesales...`);
    
    let sujetosProcesales = [];
    try {
      // Esperar a que la pestaña esté visible
      await page.waitForSelector('div.v-tab:has-text("Sujetos Procesales")', { timeout: 5000 });
      await page.click('div.v-tab:has-text("Sujetos Procesales")');
      
      // Esperar a que se cargue la tabla
      await page.waitForTimeout(2000);
      await page.waitForSelector('table tbody tr', { timeout: 8000 });
      
      const todasLasFilas = await page.locator('table tbody tr').all();
      console.log(`[scraping ${jobId}] 📊 Total filas en tabla de sujetos: ${todasLasFilas.length}`);
      
      for (const fila of todasLasFilas) {
        const celdas = await fila.locator('td').all();
        console.log(`[scraping ${jobId}] 🔍 Fila con ${celdas.length} celdas`);
        
        if (celdas.length >= 2) {
          const tipo = await celdas[0].innerText().catch(() => "");
          const nombre = await celdas[1].innerText().catch(() => "");
          
          const tipoLimpio = tipo.trim();
          const nombreLimpio = nombre.trim();
          
          console.log(`[scraping ${jobId}] 📝 Tipo: "${tipoLimpio}" | Nombre: "${nombreLimpio}"`);
          
          // Aceptar cualquier tipo, no solo Demandante/Demandado
          if (tipoLimpio && nombreLimpio) {
            sujetosProcesales.push({
              tipo: tipoLimpio,
              nombre: nombreLimpio,
            });
            console.log(`[scraping ${jobId}] ✅ Sujeto agregado: ${tipoLimpio} - ${nombreLimpio}`);
          }
        }
      }

      console.log(`[scraping ${jobId}] ✅ Sujetos encontrados: ${sujetosProcesales.length}`);
      
    } catch (error) {
      console.log(`[scraping ${jobId}] ❌ Error extrayendo sujetos: ${error.message}`);
    }

    // ================== ACTUACIONES ==================
    console.log(`[scraping ${jobId}] 7. Extrayendo actuaciones...`);
    
    let actuaciones = [];
    let resultadosEsperados = 0;
    
    try {
      await page.click('div.v-tab:has-text("Actuaciones")');
      await page.waitForSelector('table tbody tr', { timeout: 8000 });
      
      // Esperar un momento adicional para que la tabla se cargue completamente
      await page.waitForTimeout(1000);
      
      // Extraer el número de resultados esperados
      try {
        const textoResultados = await page.locator('span:has-text("Resultados encontrados")').innerText();
        const match = textoResultados.match(/(\d+)/);
        if (match) {
          resultadosEsperados = parseInt(match[1]);
          console.log(`[scraping ${jobId}] 📊 Resultados esperados según página: ${resultadosEsperados}`);
        }
      } catch (error) {
        console.log(`[scraping ${jobId}] ⚠️ No se pudo extraer número de resultados esperados`);
      }
      
      const todasLasFilasAct = await page.locator('table tbody tr').all();
      console.log(`[scraping ${jobId}] 📊 Total filas en tabla: ${todasLasFilasAct.length}`);

      for (const fila of todasLasFilasAct) {
        const cols = await fila.locator("td").all();
        
        console.log(`[scraping ${jobId}] 🔍 Fila con ${cols.length} columnas`);
        
        // La tabla puede tener 6 o 7 columnas
        if (cols.length >= 6) {
          const fecha = (await cols[0].innerText().catch(() => "")).trim();
          const actuacion = (await cols[1].innerText().catch(() => "")).trim();
          const anotacion = (await cols[2].innerText().catch(() => "")).trim();
          const fechaInicio = (await cols[3].innerText().catch(() => "")).trim();
          const fechaFin = (await cols[4].innerText().catch(() => "")).trim();
          const fechaRegistro = (await cols[5].innerText().catch(() => "")).trim();
          
          // Si hay 7 columnas, la última también puede ser fecha de registro
          const columna7 = cols.length >= 7 ? (await cols[6].innerText().catch(() => "")).trim() : "";
          
          // Validación 1: debe tener formato de fecha válido
          const esFechaValida = /^\d{4}-\d{2}-\d{2}$/.test(fecha);
          
          // Validación 2: la actuación no debe estar vacía
          const tieneActuacion = actuacion.length > 0;
          
          // Validación 3: NO debe ser un encabezado de juzgado/tribunal
          const esEncabezadoJuzgado = actuacion.toUpperCase().includes('JUZGADO') ||
                                      actuacion.toUpperCase().includes('TRIBUNAL') ||
                                      actuacion.toUpperCase().includes('CORTE');
          
          // Validación 4: NO debe ser encabezado de tabla
          const esEncabezadoTabla = actuacion.toUpperCase().includes('ACTUACIÓN') && 
                                    !esFechaValida;
          
          if (esFechaValida && tieneActuacion && !esEncabezadoJuzgado && !esEncabezadoTabla) {
            actuaciones.push({
              "Fecha de Actuación": fecha || "0",
              "Actuación": actuacion || "0",
              "Anotación": anotacion || "0",
              "Fecha inicia Término": fechaInicio || "0",
              "Fecha finaliza Término": fechaFin || "0",
              "Fecha de Registro": fechaRegistro || "0",
              "Columna 7": columna7 || "0",
            });
            console.log(`[scraping ${jobId}] ✅ Actuación agregada: ${fecha} - ${actuacion}`);
          } else {
            console.log(`[scraping ${jobId}] ⏭️ Fila ignorada: "${fecha}" - "${actuacion}" (encabezado=${esEncabezadoJuzgado || esEncabezadoTabla})`);
          }
        }
      }

      console.log(`[scraping ${jobId}] ✅ Total actuaciones capturadas: ${actuaciones.length}`);
      
      // Validar que se capturaron todas las actuaciones esperadas
      if (resultadosEsperados > 0 && actuaciones.length !== resultadosEsperados) {
        console.log(`[scraping ${jobId}] ⚠️ ADVERTENCIA: Se esperaban ${resultadosEsperados} actuaciones pero se capturaron ${actuaciones.length}`);
      } else if (resultadosEsperados > 0) {
        console.log(`[scraping ${jobId}] ✅ VERIFICADO: Se capturaron las ${resultadosEsperados} actuaciones esperadas`);
      }
      
      if (actuaciones.length === 0) {
        console.log(`[scraping ${jobId}] ⚠️ ADVERTENCIA: No se encontraron actuaciones válidas`);
      }
      
    } catch (error) {
      console.log(`[scraping ${jobId}] ❌ Error extrayendo actuaciones: ${error.message}`);
    }

    return {
      success: true,
      numero_radicacion: soloDigitos,
      proceso: ficha,
      sujetos_procesales: sujetosProcesales,
      actuaciones: actuaciones,
      total_actuaciones: actuaciones.length,
      actuaciones_esperadas: resultadosEsperados,
      validacion_completa: resultadosEsperados === 0 || actuaciones.length === resultadosEsperados,
      ultima_actuacion: actuaciones[0] || null,
    };

  } catch (error) {
    console.error(`[scraping ${jobId}] ❌ Error:`, error.message);
    throw error;
  } finally {
    await page.close();
  }
}

// ================== ENDPOINTS ==================

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

  const jobId = createJob(soloDigitos);
  queue.push({ jobId, numeroRadicacion: radicado });
  
  console.log(`[job] 🆕 Creado: ${jobId} - En cola: ${queue.length}`);

  processQueue();

  res.json({
    success: true,
    jobId: jobId,
    numero_radicacion: soloDigitos,
    status: "queued",
    queue_position: queue.length,
    message: "Búsqueda en cola. Use /resultado/:jobId para consultar el resultado.",
    poll_url: `/resultado/${jobId}`
  });
});

app.get("/resultado/:jobId", (req, res) => {
  const { jobId } = req.params;
  const job = jobs.get(jobId);

  if (!job) {
    return res.status(404).json({
      success: false,
      error: "Job no encontrado o expirado"
    });
  }

  if (job.status === "queued") {
    const position = queue.findIndex(q => q.jobId === jobId) + 1;
    return res.json({
      success: true,
      jobId: jobId,
      status: "queued",
      queue_position: position,
      numero_radicacion: job.numero_radicacion,
      message: `En cola. Posición: ${position}. Consulte nuevamente en unos segundos.`
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
  console.log(`📊 Configuración: Max ${MAX_CONCURRENT_JOBS} jobs simultáneos`);
});

server.requestTimeout = 120000;
server.headersTimeout = 120000;