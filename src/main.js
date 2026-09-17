#!/usr/bin/env node
/**
 * Punto de entrada del RPA.
 *
 *   node src/main.js --limite 10 --headed      # lote de prueba, con ventana
 *   node src/main.js                           # corrida completa
 *   node src/main.js --reintentar-errores      # vuelve sobre los fallidos
 *   node src/main.js --reintentar-no-encontrados  # vuelve sobre los sin ficha
 *   node src/main.js --solo 52427771,94501035  # documentos concretos
 *   node src/main.js --omitir-procesados       # salta los ya consultados
 */
import { leerPersonas } from './csv.js';
import { conectar, desconectar, sembrarDesdeCsv, pendientes, resumen, separarYaConsultados } from './mongo.js';
import { ejecutar } from './orquestador.js';
import { leerCredenciales } from './config.js';

const RUTA_CSV = 'HojaVidaSiscout.csv';

function leerArgumentos(argv) {
  const opciones = {
    limite: 0,
    headless: true,
    slowMo: 0,
    reintentarErrores: false,
    reintentarNoEncontrados: false,
    solo: [],
    sembrar: true,
    workers: 0,
    omitirProcesados: false,
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    const valor = () => argv[++i];

    if (arg === '--limite') opciones.limite = Number(valor());
    else if (arg === '--workers') opciones.workers = Number(valor());
    else if (arg === '--headed') { opciones.headless = false; opciones.slowMo ||= 250; }
    else if (arg === '--headless') opciones.headless = true;
    else if (arg === '--slow-mo') opciones.slowMo = Number(valor());
    else if (arg === '--reintentar-errores') opciones.reintentarErrores = true;
    else if (arg === '--reintentar-no-encontrados') opciones.reintentarNoEncontrados = true;
    else if (arg === '--solo') opciones.solo = valor().split(',').map((d) => d.trim()).filter(Boolean);
    else if (arg === '--sin-sembrar') opciones.sembrar = false;
    else if (arg === '--omitir-procesados') opciones.omitirProcesados = true;
    else if (arg === '--ayuda' || arg === '-h') { console.log(AYUDA); process.exit(0); }
    else { console.error(`Opción desconocida: ${arg}\n${AYUDA}`); process.exit(1); }
  }
  return opciones;
}

const AYUDA = `
RPA talento360 — extracción de hojas de vida a MongoDB

  --limite <n>            procesa sólo n documentos (lote de prueba)
  --solo <doc1,doc2>      procesa únicamente esos documentos
  --workers <n>           fija la concurrencia en n y desactiva la rampa
  --headed                abre el navegador con ventana visible
  --headless              sin ventana (por defecto)
  --slow-mo <ms>          ralentiza cada acción, útil para observar
  --reintentar-errores    vuelve a intentar los que quedaron en error
  --reintentar-no-encontrados
                          vuelve sobre los marcados como sin ficha. Úsalo tras
                          corregir el RPA: los negativos previos no son fiables
  --omitir-procesados     salta los que ya fueron consultados (ok o sin ficha).
                          Hace idempotente también a --solo
  --sin-sembrar           no relee el CSV, usa lo que ya hay en Mongo
  --ayuda                 esta ayuda
`;

async function principal() {
  const opciones = leerArgumentos(process.argv);
  const credenciales = leerCredenciales();

  console.log(`RPA talento360 · ${credenciales.length} credencial(es) · ${opciones.headless ? 'headless' : 'con ventana'}`);

  await conectar();
  console.log('MongoDB conectado');

  if (opciones.sembrar) {
    const { personas, estadisticas } = await leerPersonas(RUTA_CSV);
    console.log(`CSV: ${estadisticas.filas} filas → ${estadisticas.unicos} documentos únicos` +
      (estadisticas.sinDocumento ? ` (${estadisticas.sinDocumento} sin número, omitidas)` : ''));
    const siembra = await sembrarDesdeCsv(personas);
    console.log(`Siembra: ${siembra.insertados} nuevos, ${siembra.existentes} ya existían`);
  }

  // El camino normal ya es idempotente: sólo toma los que están pendientes.
  // `--solo` ignora el estado a propósito, para poder reprocesar a mano; por
  // eso `--omitir-procesados` existe y se aplica después, sobre cualquier modo.
  let documentos = opciones.solo.length
    ? opciones.solo
    : await pendientes({
        limite: opciones.limite,
        reintentarErrores: opciones.reintentarErrores,
        reintentarNoEncontrados: opciones.reintentarNoEncontrados,
      });

  if (opciones.omitirProcesados) {
    // Pedir el reproceso de los sin ficha manda sobre el omitidor: si no, un
    // flag anularía al otro en silencio.
    const { procesar, omitidos } = await separarYaConsultados(documentos, {
      incluirNoEncontrados: opciones.reintentarNoEncontrados,
    });
    if (omitidos.length) {
      console.log(`Omitidos por ya estar consultados: ${omitidos.length}` +
        (omitidos.length <= 10 ? ` (${omitidos.join(', ')})` : ''));
    }
    documentos = procesar;
  }

  if (!documentos.length) {
    console.log(
      opciones.omitirProcesados
        ? 'Nada por hacer: todos los documentos solicitados ya fueron consultados.'
        : 'No hay documentos pendientes. Usa --reintentar-errores para volver sobre los fallidos.'
    );
    await desconectar();
    return;
  }

  console.log(`Por procesar: ${documentos.length}\n`);

  const total = await ejecutar(documentos, credenciales, {
    headless: opciones.headless,
    slowMo: opciones.slowMo,
    workers: opciones.workers,
  });

  const minutos = (total.duracionMs / 60000).toFixed(1);
  console.log(`\n=== Fin en ${minutos} min ===`);
  console.log(`  extraídos   ${total.ok}`);
  console.log(`  sin ficha   ${total.noEncontrados}`);
  console.log(`  con error   ${total.errores}`);
  console.log('\nEstado de la colección:', await resumen());

  await desconectar();
}

principal().catch(async (error) => {
  console.error('\nFallo:', error.message);
  await desconectar().catch(() => {});
  process.exit(1);
});
