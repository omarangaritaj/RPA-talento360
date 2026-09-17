#!/usr/bin/env node
/**
 * Etapa 2, fase 2: descarga de los informes PDF.
 *
 *   node src/informes/main-informes.js --limite-eval 2 --headed   # prueba
 *   node src/informes/main-informes.js --sesiones 4               # corrida larga
 *   node src/informes/main-informes.js --reintentar-errores
 *
 * Recorre el listado de evaluaciones, abre las que tienen informes pendientes y
 * descarga el PDF de cada persona. Es reanudable: cada archivo se marca en
 * cuanto se guarda, así que interrumpir no pierde nada.
 *
 * POR QUÉ ESTO NO ES UN SIMPLE DESCARGADOR DE URLS
 *
 * La idea inicial era desacoplarlo del todo: la fase 1 cosecha las URLs y esta
 * fase las pide por HTTP desde una sesión limpia. No funciona. El servidor
 * responde 200 y entrega un PDF válido, pero vacío —110 KB, sin el nombre de la
 * persona— salvo que la sesión tenga ABIERTO EL DETALLE de esa evaluación. Se
 * descubrió tarde, con doce archivos ya dados por buenos.
 *
 * Así que hay que volver a navegar. Lo que sí se conserva de la fase 1 es el
 * saber a qué evaluaciones hay que entrar y a quién le falta el informe, que es
 * lo que evita abrir las ~980 evaluaciones cuando sólo interesan algunas.
 */
import { conectar, desconectar } from '../mongo.js';
import { leerCredenciales } from '../config.js';
import { SesionEvaluaciones } from '../evaluaciones/navegador-eval.js';
import { abrirListado, leerFilas, paginaActual, siguientePagina } from '../evaluaciones/listado.js';
import { abrirDetalle, recorrerPersonas, DetalleVacio } from '../evaluaciones/detalle.js';
import { cosecharUrl } from '../evaluaciones/cosecha-urls.js';
import {
  claveDeEvaluacion,
  informesPendientes,
  marcarInformeDescargado,
  marcarInformeError,
  resumenInformes,
} from '../evaluaciones/mongo-eval.js';
import { MAX_PAGINAS } from '../evaluaciones/config-eval.js';
import { descargarInforme } from './descargador.js';

const log = (m) => console.log(`[${new Date().toLocaleTimeString('es-CO')}] ${m}`);

const AYUDA = `
Etapa 2 · fase 2 — descarga de los informes PDF

  --limite-eval <n>        procesa sólo n evaluaciones
  --sesiones <n>           sesiones en paralelo (por defecto 2)
  --destino <ruta>         carpeta de salida (por defecto ./informes)
  --reintentar-errores     vuelve sobre los que fallaron
  --headed                 con ventana visible
  --ayuda                  esta ayuda

Cada PDF se guarda como <id>.pdf junto a un <id>.json con el nombre, la cédula
y la evaluación. El id es único por persona y evaluación.

Cada informe tarda entre uno y tres minutos: el servidor lo arma al pedirlo.
El paralelismo sale de abrir varias sesiones, no de pedir varias cosas a la vez:
ASP.NET serializa las peticiones de una misma sesión.
`;

function leerArgumentos(argv) {
  const o = { limiteEval: 0, sesiones: 2, destino: 'informes', reintentarErrores: false, headless: true };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    const valor = () => argv[++i];

    if (arg === '--limite-eval') o.limiteEval = Number(valor());
    else if (arg === '--sesiones') o.sesiones = Math.max(1, Number(valor()));
    else if (arg === '--destino') o.destino = valor();
    else if (arg === '--reintentar-errores') o.reintentarErrores = true;
    else if (arg === '--headed') o.headless = false;
    else if (arg === '--ayuda' || arg === '-h') { console.log(AYUDA); process.exit(0); }
    else { console.error(`Opción desconocida: ${arg}\n${AYUDA}`); process.exit(1); }
  }
  return o;
}

/**
 * Descarga los informes pendientes de la evaluación que ya está abierta.
 *
 * Se recorre a la gente y se vuelve a pedir su URL en lugar de usar la guardada
 * en la fase 1. Cuesta 330 ms por persona y evita depender de que los índices
 * de fila sigan significando lo mismo que entonces: si alguien se dio de alta o
 * de baja desde la cosecha, el índice guardado apuntaría a otra persona.
 *
 * @param {Map<string,Object>} pendientesPorId informes que faltan, por id
 */
async function descargarEvaluacionAbierta(sesion, pendientesPorId, opciones, contadores) {
  await recorrerPersonas(sesion, async (personas) => {
    for (const persona of personas) {
      const url = await cosecharUrl(sesion, persona.indice);
      if (!url.url || !url.id) {
        log(`    · ${persona.nombre}: sin URL (${url.motivo ?? 'desconocido'})`);
        continue;
      }

      const pendiente = pendientesPorId.get(url.id);
      if (!pendiente) continue; // ya descargado en otra corrida, o no es de este worker

      const t0 = Date.now();
      const r = await descargarInforme(
        sesion,
        { ...pendiente, url: url.url, nombre: persona.nombre },
        opciones.destino
      ).catch((e) => ({ ok: false, motivo: e.message }));

      const seg = ((Date.now() - t0) / 1000).toFixed(0);
      const quien = `${persona.nombre} (${pendiente.documento ?? 'sin cédula'})`;

      if (r.ok) {
        await marcarInformeDescargado(pendiente.claveEvaluacion, url.id, {
          archivo: r.archivo,
          bytes: r.bytes,
        });
        contadores.ok++;
        contadores.bytes += r.bytes;
        log(`    ✓ ${url.id} · ${quien} · ${(r.bytes / 1024).toFixed(0)} KB · ${seg}s`);
      } else {
        await marcarInformeError(pendiente.claveEvaluacion, url.id, r.motivo);
        contadores.errores++;
        log(`    ✗ ${url.id} · ${quien} · ${r.motivo} · ${seg}s`);
      }
      pendientesPorId.delete(url.id);
    }
    return personas;
  });
}

async function principal() {
  const opciones = leerArgumentos(process.argv);
  const [credencial] = leerCredenciales();

  await conectar();
  log('MongoDB conectado');

  const pendientes = await informesPendientes({ reintentarErrores: opciones.reintentarErrores });
  if (!pendientes.length) {
    console.log('No hay informes pendientes. Usa --reintentar-errores para volver sobre los fallidos.');
    console.log('Estado:', await resumenInformes());
    await desconectar();
    return;
  }

  // Agrupados por evaluación: se abre cada una una sola vez y se bajan todos
  // sus informes de una pasada.
  const porEvaluacion = new Map();
  for (const p of pendientes) {
    if (!porEvaluacion.has(p.claveEvaluacion)) porEvaluacion.set(p.claveEvaluacion, new Map());
    porEvaluacion.get(p.claveEvaluacion).set(p.id, p);
  }

  const claves = [...porEvaluacion.keys()];
  const objetivo = opciones.limiteEval ? claves.slice(0, opciones.limiteEval) : claves;
  const asignadas = new Set(objetivo);

  log(`Pendientes: ${pendientes.length} informes en ${claves.length} evaluación(es)`);
  log(`A procesar: ${objetivo.length} evaluación(es) con ${opciones.sesiones} sesión(es)`);
  log('Cada informe tarda entre uno y tres minutos: el servidor lo arma al pedirlo.');

  const contadores = { ok: 0, errores: 0, bytes: 0, evaluaciones: 0 };
  const inicio = Date.now();
  // Reparto round-robin: cada worker recorre el listado y atiende su turno.
  const tomadas = new Set();

  /**
   * Un worker: recorre el listado de principio a fin y, al encontrar una
   * evaluación asignada que nadie haya tomado, la abre y descarga lo suyo.
   *
   * Recorrer el listado entero cuesta unos minutos, despreciable frente a los
   * minutos que cuesta cada informe. Reclamar las evaluaciones sobre la marcha
   * evita tener que repartirlas de antemano sin saber cuánto tarda cada una.
   */
  async function worker(indice) {
    const sesion = new SesionEvaluaciones(credencial, { headless: opciones.headless });
    try {
      await sesion.abrir();
      await sesion.login();
      await abrirListado(sesion);
      log(`[worker-${indice}] sesión lista`);

      for (let vuelta = 0; vuelta < MAX_PAGINAS; vuelta++) {
        const pagina = await paginaActual(sesion.page);
        const filas = await leerFilas(sesion.page);

        for (const fila of filas) {
          const clave = claveDeEvaluacion(fila);
          if (!asignadas.has(clave) || tomadas.has(clave)) continue;
          tomadas.add(clave);

          const faltan = porEvaluacion.get(clave);
          log(`[worker-${indice}] p${pagina} · ${fila.medicion.slice(0, 44)} · ${faltan.size} informe(s)`);

          try {
            await abrirDetalle(sesion, fila.indiceSelect);
            await descargarEvaluacionAbierta(sesion, faltan, opciones, contadores);
            contadores.evaluaciones++;
          } catch (error) {
            if (error instanceof DetalleVacio) {
              log(`[worker-${indice}] detalle vacío, se salta`);
            } else {
              log(`[worker-${indice}] error: ${error.message.slice(0, 120)}`);
              // La página puede quedar inservible: se recarga y se sigue.
              await abrirListado(sesion).catch(() => {});
            }
          }
        }

        if (tomadas.size >= asignadas.size) break;
        const avance = await siguientePagina(sesion);
        if (!avance.avanzo) break;
      }
    } finally {
      await sesion.cerrar().catch(() => {});
      log(`[worker-${indice}] terminado`);
    }
  }

  try {
    await Promise.all(
      Array.from({ length: opciones.sesiones }, (_, i) =>
        worker(i + 1).catch((e) => log(`[worker-${i + 1}] abortado: ${e.message}`))
      )
    );
  } finally {
    const minutos = ((Date.now() - inicio) / 60000).toFixed(1);
    console.log(`\n=== Fin en ${minutos} min ===`);
    console.log(`  evaluaciones abiertas  ${contadores.evaluaciones}`);
    console.log(`  informes descargados   ${contadores.ok}`);
    console.log(`  con error              ${contadores.errores}`);
    console.log(`  total                  ${(contadores.bytes / 1024 / 1024).toFixed(1)} MB`);
    console.log('\nEstado de los informes:', await resumenInformes());
    await desconectar();
  }
}

principal().catch(async (error) => {
  console.error('\nFallo:', error.message);
  await desconectar().catch(() => {});
  process.exit(1);
});
