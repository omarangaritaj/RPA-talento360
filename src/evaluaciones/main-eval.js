#!/usr/bin/env node
/**
 * Etapa 2, fase 1: cosecha de evaluaciones de desempeño.
 *
 *   node src/evaluaciones/main-eval.js --limite-paginas 1 --headed
 *   node src/evaluaciones/main-eval.js                       # corrida completa
 *   node src/evaluaciones/main-eval.js --desde-pagina 42     # reanudar
 *   node src/evaluaciones/main-eval.js --sin-informes        # sólo datos
 *
 * Recorre el listado paginado, abre cada evaluación con personas, lee evaluados
 * y evaluadores, resuelve las cédulas contra `perfiles` y cosecha las URLs de
 * los informes. La descarga de los PDF es la fase 2 y vive aparte.
 */
import { conectar, desconectar } from '../mongo.js';
import { leerCredenciales } from '../config.js';
import { SesionEvaluaciones } from './navegador-eval.js';
import { abrirListado, leerFilas, paginaActual, siguientePagina, irAPagina } from './listado.js';
import { abrirDetalle, recorrerPersonas, DetalleVacio } from './detalle.js';
import { cosecharUrls } from './cosecha-urls.js';
import { construirIndice, resolverEvaluacion, contarMatches } from './match.js';
import {
  Evaluacion,
  ESTADOS_EVAL,
  ESTADOS_INFORME,
  claveDeEvaluacion,
  clavesProcesadas,
  guardarEvaluacion,
  guardarFalloEvaluacion,
  resumenEvaluaciones,
  sincronizarIndices,
} from './mongo-eval.js';
import { MAX_PAGINAS, TIEMPOS_EVAL } from './config-eval.js';

const log = (m) => console.log(`[${new Date().toLocaleTimeString('es-CO')}] ${m}`);
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

const AYUDA = `
Etapa 2 · fase 1 — cosecha de evaluaciones de desempeño

  --limite-paginas <n>   procesa sólo n páginas (lote de prueba)
  --desde-pagina <n>     empieza en esa página (para reanudar)
  --limite-eval <n>      procesa sólo n evaluaciones y termina
  --sin-informes         no cosecha las URLs de los PDF, sólo datos
  --reprocesar           vuelve sobre las evaluaciones ya guardadas
  --incluir-vacias       abre también las que marcan progreso 0/0
  --headed               abre el navegador con ventana visible
  --slow-mo <ms>         ralentiza cada acción, útil para observar
  --ayuda                esta ayuda
`;

function leerArgumentos(argv) {
  const o = {
    limitePaginas: 0,
    desdePagina: 1,
    limiteEval: 0,
    conInformes: true,
    reprocesar: false,
    incluirVacias: false,
    headless: true,
    slowMo: 0,
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    const valor = () => argv[++i];

    if (arg === '--limite-paginas') o.limitePaginas = Number(valor());
    else if (arg === '--desde-pagina') o.desdePagina = Math.max(1, Number(valor()));
    else if (arg === '--limite-eval') o.limiteEval = Number(valor());
    else if (arg === '--sin-informes') o.conInformes = false;
    else if (arg === '--reprocesar') o.reprocesar = true;
    else if (arg === '--incluir-vacias') o.incluirVacias = true;
    else if (arg === '--headed') { o.headless = false; o.slowMo ||= 150; }
    else if (arg === '--headless') o.headless = true;
    else if (arg === '--slow-mo') o.slowMo = Number(valor());
    else if (arg === '--ayuda' || arg === '-h') { console.log(AYUDA); process.exit(0); }
    else { console.error(`Opción desconocida: ${arg}\n${AYUDA}`); process.exit(1); }
  }
  return o;
}

/**
 * Procesa una evaluación completa: detalle, personas, match y URLs.
 * @returns {Promise<{estado:string, datos?:Object, motivo?:string}>}
 */
async function procesarEvaluacion(sesion, fila, contexto) {
  const { opciones, indiceMatch, porNombreEvaluado, pagina } = contexto;

  // El listado ya dice cuántos evaluados hay. Si son cero, abrir el detalle es
  // gastar el tiempo de espera completo para no encontrar tabla: la aplicación
  // no renderiza nada cuando no hay filas.
  if (fila.progreso.total === 0 && !opciones.incluirVacias) {
    return { estado: ESTADOS_EVAL.vacia, motivo: 'progreso 0/0 en el listado' };
  }

  try {
    await abrirDetalle(sesion, fila.indiceSelect);
  } catch (error) {
    if (error instanceof DetalleVacio) {
      return { estado: ESTADOS_EVAL.vacia, motivo: error.message };
    }
    throw error;
  }

  // La grilla de personas pagina cada diez evaluados. Se recorre página por
  // página y las URLs se cosechan sobre la marcha, porque los botones de
  // informe se renumeran desde cero en cada una.
  const { personas: evaluados, paginas: paginasPersonas } = await recorrerPersonas(
    sesion,
    async (personas, paginaPersonas) => {
      let urls = [];
      if (opciones.conInformes) {
        urls = await cosecharUrls(sesion, personas);
      }

      return personas.map((persona) => {
        const encontrada = urls.find((u) => u.indice === persona.indice);
        return {
          ...persona,
          paginaPersonas,
          informe: !opciones.conInformes
            ? undefined
            : encontrada?.url
              ? {
                  url: encontrada.url,
                  id: encontrada.id,
                  group: encontrada.group,
                  cargo: encontrada.cargo,
                  estado: ESTADOS_INFORME.pendiente,
                }
              : { estado: ESTADOS_INFORME.sinUrl, ultimoError: encontrada?.motivo ?? 'sin intento' },
        };
      });
    }
  );

  if (!evaluados.length) {
    return { estado: ESTADOS_EVAL.vacia, motivo: 'la tabla de personas no trajo filas' };
  }

  return {
    estado: ESTADOS_EVAL.ok,
    datos: {
      ...fila,
      paginaOrigen: pagina,
      indiceSelect: fila.indiceSelect,
      evaluados: resolverEvaluacion(evaluados, indiceMatch, porNombreEvaluado),
      paginasPersonas,
      // Si el listado decía 8 evaluados y leímos 7, algo se perdió. Queda
      // registrado en el documento en vez de pasar inadvertido.
      verificacion: {
        declaradosEnListado: fila.progreso.total,
        leidosEnDetalle: evaluados.length,
        coincide: fila.progreso.total === evaluados.length,
      },
    },
  };
}

async function principal() {
  const opciones = leerArgumentos(process.argv);
  const [credencial] = leerCredenciales();

  console.log(
    `Etapa 2 · fase 1 · ${opciones.headless ? 'headless' : 'con ventana'}` +
      `${opciones.conInformes ? ' · cosechando URLs de informes' : ' · sólo datos'}`
  );

  await conectar();
  await sincronizarIndices();
  log('MongoDB conectado');

  const indiceMatch = await construirIndice();
  log(`Índice de match: ${indiceMatch.total} perfiles · ${indiceMatch.porEmail.size} emails · ${indiceMatch.porNombre.size} nombres`);

  const yaHechas = opciones.reprocesar ? new Set() : await clavesProcesadas();
  if (yaHechas.size) log(`Ya procesadas: ${yaHechas.size} evaluaciones (se saltan)`);

  const sesion = new SesionEvaluaciones(credencial, {
    headless: opciones.headless,
    slowMo: opciones.slowMo,
  });
  await sesion.abrir();
  await sesion.login();
  log(`Sesión iniciada como ${credencial.usuario}`);

  await abrirListado(sesion);

  if (opciones.desdePagina > 1) {
    log(`Avanzando hasta la página ${opciones.desdePagina}…`);
    const llegada = await irAPagina(sesion, opciones.desdePagina, (p) => {
      if (p % 10 === 0) log(`  …página ${p}`);
    });
    if (llegada < opciones.desdePagina) {
      log(`Sólo se pudo llegar a la página ${llegada}`);
    }
  }

  /** Índice auxiliar nombre→cédula que van alimentando los evaluados resueltos. */
  const porNombreEvaluado = new Map();
  const contadores = { ok: 0, vacias: 0, errores: 0, omitidas: 0, evaluados: 0, urls: 0 };
  const matchesGlobal = {};
  const inicio = Date.now();
  let paginasHechas = 0;
  let terminar = false;

  try {
    for (let vuelta = 0; vuelta < MAX_PAGINAS && !terminar; vuelta++) {
      const pagina = await paginaActual(sesion.page);
      const filas = await leerFilas(sesion.page);
      log(`— página ${pagina}: ${filas.length} evaluaciones`);

      for (const fila of filas) {
        const clave = claveDeEvaluacion(fila);

        if (yaHechas.has(clave)) {
          contadores.omitidas++;
          continue;
        }

        const etiqueta = `${fila.medicion || '(sin nombre)'} · ${fila.grupo} · ${fila.progreso.crudo}`;
        const t0 = Date.now();

        try {
          const r = await procesarEvaluacion(sesion, fila, {
            opciones,
            indiceMatch,
            porNombreEvaluado,
            pagina,
          });

          if (r.estado === ESTADOS_EVAL.ok) {
            await guardarEvaluacion(clave, { ...r.datos, duracionMs: Date.now() - t0 });
            const urls = r.datos.evaluados.filter((e) => e.informe?.url).length;
            contadores.ok++;
            contadores.evaluados += r.datos.evaluados.length;
            contadores.urls += urls;
            for (const [k, v] of Object.entries(contarMatches(r.datos.evaluados))) {
              matchesGlobal[k] = (matchesGlobal[k] ?? 0) + v;
            }
            const aviso = r.datos.verificacion.coincide ? '' : ' ⚠ conteo no coincide';
            log(`  ✓ ${etiqueta} → ${r.datos.evaluados.length} evaluados, ${urls} URLs (${((Date.now() - t0) / 1000).toFixed(1)}s)${aviso}`);
          } else {
            await guardarFalloEvaluacion(clave, fila, {
              estado: r.estado,
              mensaje: r.motivo,
              paginaOrigen: pagina,
            });
            contadores.vacias++;
            log(`  · ${etiqueta} → vacía (${r.motivo})`);
          }
        } catch (error) {
          await guardarFalloEvaluacion(clave, fila, {
            estado: ESTADOS_EVAL.error,
            mensaje: error.message,
            paginaOrigen: pagina,
          });
          contadores.errores++;
          log(`  ✗ ${etiqueta} → ${error.message.slice(0, 140)}`);

          // Un fallo puede dejar la página en un estado inservible. Recargar el
          // listado y volver a esta página cuesta, pero seguir sobre un DOM roto
          // cuesta más: arrastraría el error al resto de la página.
          await abrirListado(sesion).catch(() => {});
          await irAPagina(sesion, pagina).catch(() => {});
        }

        const hechas = contadores.ok + contadores.vacias + contadores.errores;
        if (opciones.limiteEval && hechas >= opciones.limiteEval) {
          log('Alcanzado --limite-eval');
          terminar = true;
          break;
        }
        await dormir(TIEMPOS_EVAL.pausaEntreEvaluaciones);
      }

      if (terminar) break;
      paginasHechas++;
      if (opciones.limitePaginas && paginasHechas >= opciones.limitePaginas) {
        log('Alcanzado --limite-paginas');
        break;
      }

      const avance = await siguientePagina(sesion);
      if (!avance.avanzo) {
        log(`Fin del listado en la página ${avance.pagina}: ${avance.motivo}`);
        break;
      }
    }
  } finally {
    await cerrar();
  }

  async function cerrar() {
    if (sesion.bloqueadosPorPatron.length) {
      log(`ATENCIÓN: el guard bloqueó ${sesion.bloqueadosPorPatron.length} click(s) sobre controles prohibidos`);
      console.error(sesion.bloqueadosPorPatron);
    }
    await sesion.cerrar();

    const minutos = ((Date.now() - inicio) / 60000).toFixed(1);
    console.log(`\n=== Fin en ${minutos} min ===`);
    console.log(`  evaluaciones ok   ${contadores.ok}`);
    console.log(`  vacías            ${contadores.vacias}`);
    console.log(`  con error         ${contadores.errores}`);
    console.log(`  omitidas          ${contadores.omitidas}`);
    console.log(`  evaluados leídos  ${contadores.evaluados}`);
    console.log(`  URLs cosechadas   ${contadores.urls}`);

    if (Object.keys(matchesGlobal).length) {
      console.log('\nCalidad del match:');
      for (const [clave, total] of Object.entries(matchesGlobal).sort()) {
        console.log(`  ${clave.padEnd(34)} ${total}`);
      }
    }

    console.log('\nEstado de la colección:', await resumenEvaluaciones());
    await desconectar();
  }
}

principal().catch(async (error) => {
  console.error('\nFallo:', error.message);
  console.error(error.stack);
  await desconectar().catch(() => {});
  process.exit(1);
});
