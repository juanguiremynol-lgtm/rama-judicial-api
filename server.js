// Cliente para usar con el sistema de jobs async
// Funciona en Lovable.dev y evita timeouts

const API_URL = "TU_URL_DEL_SERVIDOR"; // Ejemplo: "https://tu-api.railway.app"

/**
 * Consulta un proceso judicial con polling automático
 * @param {string} numeroRadicacion - Número de radicación de 23 dígitos
 * @param {function} onProgress - Callback para actualizaciones de progreso
 * @returns {Promise<object>} - Resultado de la consulta
 */
async function consultarProceso(numeroRadicacion, onProgress = null) {
  try {
    // 1. Iniciar la búsqueda
    if (onProgress) onProgress({ status: "iniciando", message: "Iniciando búsqueda..." });
    
    const initResponse = await fetch(
      `${API_URL}/buscar?numero_radicacion=${numeroRadicacion}`
    );
    
    if (!initResponse.ok) {
      const error = await initResponse.json();
      throw new Error(error.error || "Error al iniciar búsqueda");
    }

    const { jobId, poll_url } = await initResponse.json();
    console.log("Job creado:", jobId);

    // 2. Hacer polling hasta que complete
    if (onProgress) onProgress({ status: "procesando", message: "Extrayendo datos..." });
    
    const maxIntentos = 60; // 60 intentos = 1 minuto máximo
    let intentos = 0;

    while (intentos < maxIntentos) {
      await new Promise(resolve => setTimeout(resolve, 2000)); // Esperar 2 segundos
      
      const resultResponse = await fetch(`${API_URL}${poll_url}`);
      const result = await resultResponse.json();

      if (result.status === "completed") {
        if (onProgress) onProgress({ status: "completado", message: "¡Búsqueda completada!" });
        return result;
      }

      if (result.status === "failed") {
        throw new Error(result.error || "Error al procesar la búsqueda");
      }

      // Aún procesando
      intentos++;
      if (onProgress) {
        onProgress({ 
          status: "procesando", 
          message: `Procesando... (${intentos * 2}s)` 
        });
      }
    }

    throw new Error("Timeout: La búsqueda tomó demasiado tiempo");

  } catch (error) {
    console.error("Error en consultarProceso:", error);
    throw error;
  }
}

// ================== EJEMPLO DE USO EN REACT ==================

// Componente React para Lovable.dev
function ConsultaProcesoComponent() {
  const [numeroRadicacion, setNumeroRadicacion] = React.useState("");
  const [loading, setLoading] = React.useState(false);
  const [progress, setProgress] = React.useState(null);
  const [resultado, setResultado] = React.useState(null);
  const [error, setError] = React.useState(null);

  const handleConsultar = async () => {
    setLoading(true);
    setError(null);
    setResultado(null);
    setProgress(null);

    try {
      const result = await consultarProceso(
        numeroRadicacion,
        (progressInfo) => {
          setProgress(progressInfo);
        }
      );
      
      setResultado(result);
      setProgress({ status: "completado", message: "✅ Búsqueda exitosa" });
    } catch (err) {
      setError(err.message);
      setProgress(null);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="p-6">
      <h1 className="text-2xl font-bold mb-4">Consulta Rama Judicial</h1>
      
      <div className="mb-4">
        <input
          type="text"
          value={numeroRadicacion}
          onChange={(e) => setNumeroRadicacion(e.target.value)}
          placeholder="Número de radicación (23 dígitos)"
          className="border p-2 w-full rounded"
          maxLength={23}
        />
      </div>

      <button
        onClick={handleConsultar}
        disabled={loading || numeroRadicacion.length !== 23}
        className="bg-blue-500 text-white px-4 py-2 rounded disabled:bg-gray-300"
      >
        {loading ? "Consultando..." : "Consultar"}
      </button>

      {progress && (
        <div className="mt-4 p-4 bg-blue-50 rounded">
          <p className="font-semibold">{progress.message}</p>
        </div>
      )}

      {error && (
        <div className="mt-4 p-4 bg-red-50 text-red-700 rounded">
          <p>❌ {error}</p>
        </div>
      )}

      {resultado && resultado.success && (
        <div className="mt-4 p-4 bg-green-50 rounded">
          <h2 className="font-bold text-lg mb-2">Resultado</h2>
          <div className="space-y-2">
            <p><strong>Radicación:</strong> {resultado.numero_radicacion}</p>
            <p><strong>Total actuaciones:</strong> {resultado.total_actuaciones}</p>
            
            {resultado.ultima_actuacion && (
              <div className="mt-2 p-2 bg-white rounded">
                <p className="font-semibold">Última actuación:</p>
                <p>{resultado.ultima_actuacion.Actuación}</p>
                <p className="text-sm text-gray-600">
                  {resultado.ultima_actuacion["Fecha de Actuación"]}
                </p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ================== EJEMPLO DE USO SIMPLE ==================

// Uso directo sin React
async function ejemploSimple() {
  console.log("Iniciando consulta...");
  
  const resultado = await consultarProceso(
    "11001020300020240012345", // Tu número de radicación
    (progress) => console.log("Progreso:", progress.message)
  );
  
  console.log("Resultado:", resultado);
  
  if (resultado.success) {
    console.log("Proceso encontrado!");
    console.log("Sujetos:", resultado.sujetos_procesales);
    console.log("Actuaciones:", resultado.total_actuaciones);
  }
}
