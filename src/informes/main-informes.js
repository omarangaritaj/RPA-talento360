#!/usr/bin/env node
/**
 * Etapa 2, fase 2: descarga de los informes PDF.
 *
 *   node src/informes/main-informes.js --limite 5          # prueba corta
 *   node src/informes/main-informes.js --sesiones 6        # corrida larga
 *   node src/informes/main-informes.js --reintentar-errores
 *
 * Lee de Mongo los informes con URL y estado pendiente y los baja a disco. Es
 * reanudable por construcción: cada archivo se marca en cuanto se guarda, así
 * que interrumpir la corrida no pierde nada y volver a lanzarla sigue donde iba.
 *
 * Sobre `--sesiones`: el servidor tarda minutos en generar cada PDF y mantiene
 * el lock de la sesión mientras tanto, así que el paralelismo se consigue con
 * varias sesiones y no con varias peticiones. Conviene subirlo con cuidado y
 * mirando los errores: es una aplicación de producción ajena.
 */
import { conectar, desconectar } from '../mongo.js';
import { leerCredenciales } from '../config.js';
import {
  informesPendientes,
  marcarInformeDescargado,
  marcarInformeError,
  resumenInformes,
} from '../evaluaciones/mongo-eval.js';
import { abrirSesiones, descargarInforme } from './descargador.js';

const log = (m) => console.log(`[${new Date().toLocaleTimeString('es-CO')}] ${m}`);

const AYUDA = `
Etapa 2 · fase 2 — descarga de los informes PDF

  --limite <n>             descarga sólo n informes
  --sesiones <n>           sesiones en paralelo (por defecto 2)
  --destino <ruta>         carpeta de salida (por defecto ./informes)
  --reintentar-errores     vuelve sobre los que fallaron
  --headed                 abre el navegador con ventana visible
  --ayuda                  esta ayuda

Cada PDF se guarda como <id>.pdf junto a un <id>.json con el nombre, la cédula
y la evaluación a la que pertenece. El id es único por persona y evaluación.
`;

function leerArgumentos(argv) {
  const o = { limite: 0, sesiones: 2, destino: 'informes', reintentarErrores: false, headless: true };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    const valor = () => argv[++i];

    if (arg === '--limite') o.limite = Number(valor());
    else if (arg === '--sesiones') o.sesiones = Math.max(1, Number(valor()));
    else if (arg === '--destino') o.destino = valor();
    else if (arg === '--reintentar-errores') o.reintentarErrores = true;
    else if (arg === '--headed') o.headless = false;
    else if (arg === '--ayuda' || arg === '-h') { console.log(AYUDA); process.exit(0); }
    else { console.error(`Opción desconocida: ${arg}\n${AYUDA}`); process.exit(1); }
  }
  return o;
}

async function principal() {
  const opciones = leerArgumentos(process.argv);
  const [credencial] = leerCredenciales();

  await conectar();
  log('MongoDB conectado');

  const pendientes = await informesPendientes({
    limite: opciones.limite,
    reintentarErrores: opciones.reintentarErrores,
  });

  if (!pendientes.length) {
    console.log('No hay informes pendientes. Usa --reintentar-errores para volver sobre los fallidos.');
    console.log('Estado:', await resumenInformes());
    await desconectar();
    return;
  }

  log(`Por descargar: ${pendientes.length} informes · ${opciones.sesiones} sesión(es) · destino "${opciones.destino}"`);
  log('Cada informe tarda entre 2 y 4 minutos: el servidor lo genera al pedirlo.');

  const { navegador, sesiones } = await abrirSesiones(credencial, opciones.sesiones, {
    headless: opciones.headless,
  });
  log(`${sesiones.length} sesión(es) abiertas`);

  // Cola compartida: cada worker toma el siguiente en cuanto se libera.
  let siguiente = 0;
  const contadores = { ok: 0, errores: 0, bytes: 0 };
  const inicio = Date.now();

  async function worker(sesion) {
    while (siguiente < pendientes.length) {
      const informe = pendientes[siguiente++];
      const t0 = Date.now();

      const r = await descargarInforme(sesion, informe, opciones.destino).catch((e) => ({
        ok: false,
        motivo: e.message,
      }));

      const seg = ((Date.now() - t0) / 1000).toFixed(0);
      const quien = `${informe.nombre ?? '?'} (${informe.documento ?? 'sin cédula'})`;

      if (r.ok) {
        await marcarInformeDescargado(informe.claveEvaluacion, informe.id, {
          archivo: r.archivo,
          bytes: r.bytes,
        });
        contadores.ok++;
        contadores.bytes += r.bytes;
        log(`  ✓ ${informe.id} · ${quien} · ${(r.bytes / 1024).toFixed(0)} KB · ${seg}s`);
      } else {
        await marcarInformeError(informe.claveEvaluacion, informe.id, r.motivo);
        contadores.errores++;
        log(`  ✗ ${informe.id} · ${quien} · ${r.motivo} · ${seg}s`);
      }

      const hechos = contadores.ok + contadores.errores;
      if (hechos % 10 === 0) informarProgreso(hechos, pendientes.length, contadores, inicio);
    }
  }

  try {
    await Promise.all(sesiones.map((s) => worker(s)));
  } finally {
    await navegador.close().catch(() => {});

    const minutos = ((Date.now() - inicio) / 60000).toFixed(1);
    console.log(`\n=== Fin en ${minutos} min ===`);
    console.log(`  descargados  ${contadores.ok}`);
    console.log(`  con error    ${contadores.errores}`);
    console.log(`  total        ${(contadores.bytes / 1024 / 1024).toFixed(1)} MB`);
    console.log('\nEstado de los informes:', await resumenInformes());
    await desconectar();
  }
}

function informarProgreso(hechos, total, contadores, inicio) {
  const transcurrido = (Date.now() - inicio) / 1000;
  const porSegundo = hechos / transcurrido;
  const restan = porSegundo > 0 ? (total - hechos) / porSegundo : 0;
  const hhmm = (s) => `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  log(
    `${hechos}/${total} · ok ${contadores.ok} · error ${contadores.errores} · ` +
      `${(contadores.bytes / 1024 / 1024).toFixed(0)} MB · restan ~${hhmm(restan)}`
  );
}

principal().catch(async (error) => {
  console.error('\nFallo:', error.message);
  await desconectar().catch(() => {});
  process.exit(1);
});
