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
  --sesiones <n>           sesiones en paralelo. Nunca más que cuentas haya en
                           .env: dos sesiones sobre la misma cuenta se pisan el
                           estado en el servidor y bajan informes VACÍOS
  --destino <ruta>         carpeta de salida (por defecto ./informes)
  --reintentar-errores     vuelve sobre los que fallaron
  --incluir-sin-respuestas incluye a quienes no tienen ningún evaluador
                           finalizado. Su informe sale vacío: sólo para auditar
  --headed                 con ventana visible
  --ayuda                  esta ayuda

Cada PDF se guarda como <id>.pdf junto a un <id>.json con el nombre, la cédula
y la evaluación. El id es único por persona y evaluación.

Lo que no pasa la validación NO se tira: va a <destino>/cuarentena/ con un JSON
que dice cuántas páginas traía, cuánto pesaba, cuánto tardó y por qué se
rechazó. Revísalo de vez en cuando: es la única forma de enterarse de si el
filtro está descartando informes buenos.

La validación necesita pdftotext (paquete poppler-utils). Sin él se cae a una
comprobación más burda y avisa por consola.

Cada informe tarda entre uno y tres minutos: el servidor lo arma al pedirlo.
El paralelismo sale de abrir varias sesiones, no de pedir varias cosas a la vez:
ASP.NET serializa las peticiones de una misma sesión.
`;

function leerArgumentos(argv) {
  const o = {
    limiteEval: 0,
    sesiones: 2,
    destino: 'informes',
    reintentarErrores: false,
    // Por omisión se saltan los que no tienen ningún evaluador finalizado: el
    // servidor devuelve para ellos un esqueleto vacío, y cuesta tres minutos.
    incluirSinRespuestas: false,
    headless: true,
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    const valor = () => argv[++i];

    if (arg === '--limite-eval') o.limiteEval = Number(valor());
    else if (arg === '--sesiones') o.sesiones = Math.max(1, Number(valor()));
    else if (arg === '--destino') o.destino = valor();
    else if (arg === '--reintentar-errores') o.reintentarErrores = true;
    else if (arg === '--incluir-sin-respuestas') o.incluirSinRespuestas = true;
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
          paginas: r.paginas,
          ms: r.ms,
        });
        contadores.ok++;
        contadores.bytes += r.bytes;
        log(
          `    ✓ ${url.id} · ${quien} · ${r.paginas} pág · ${(r.bytes / 1024).toFixed(0)} KB · ${seg}s` +
            (r.dudoso ? ' · DUDOSO, revísalo' : '')
        );
      } else {
        await marcarInformeError(pendiente.claveEvaluacion, url.id, {
          mensaje: r.motivo,
          paginas: r.paginas,
          bytes: r.bytes,
          ms: r.ms,
          cuarentena: r.cuarentena,
        });
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

  /**
   * Una cuenta por sesión, sin excepción.
   *
   * Cada worker abre su propio contexto de navegador, así que tiene su propia
   * cookie y su propio SessionID… y aun así dos workers sobre la MISMA cuenta
   * se estorban: el estado que hace falta para que el servidor arme el informe
   * —qué evaluación está abierta y de quién se pidió el informe— vive del lado
   * del servidor, atado a la cuenta, no a la cookie.
   *
   * El síntoma no es un error, que sería fácil: es que el informe llega vacío.
   * Con dos workers sobre una sola cuenta, 25 de 28 descargas devolvieron el
   * esqueleto de diez páginas; el mismo flujo con una sola sesión los devolvía
   * completos. Pedir más sesiones que cuentas hay no acelera nada: multiplica
   * los informes vacíos y cuesta dos minutos de servidor cada uno.
   */
  const credenciales = leerCredenciales();
  if (opciones.sesiones > credenciales.length) {
    log(
      `AVISO: pediste ${opciones.sesiones} sesión(es) pero en .env hay ${credenciales.length} ` +
        `cuenta(s). Se usa ${credenciales.length}: compartir cuenta entre sesiones hace que ` +
        `el servidor devuelva informes VACÍOS. Define USER_2/PASSWORD_2 para ir en paralelo.`
    );
    opciones.sesiones = credenciales.length;
  }

  await conectar();
  log('MongoDB conectado');

  const pendientes = await informesPendientes({
    reintentarErrores: opciones.reintentarErrores,
    incluirSinRespuestas: opciones.incluirSinRespuestas,
  });
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
  if (!opciones.incluirSinRespuestas) {
    log('Se saltan los evaluados sin ningún evaluador finalizado: su informe sale vacío.');
  }
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
    // Una cuenta distinta por worker: ver el comentario en `principal`.
    const credencial = credenciales[indice - 1];
    const sesion = new SesionEvaluaciones(credencial, { headless: opciones.headless });
    try {
      await sesion.abrir();
      await sesion.login();
      await abrirListado(sesion);
      log(`[worker-${indice}] sesión lista como ${credencial.usuario}`);

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
