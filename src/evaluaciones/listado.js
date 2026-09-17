/**
 * Recorrido del listado de evaluaciones (#MainContent_GrdEvalDesempeno).
 *
 * La grilla trae 7 filas de datos por página y pagina con postbacks
 * `Page$N`. El paginador no ofrece todas las páginas a la vez: muestra una
 * ventana de números y unos puntos suspensivos que saltan al siguiente bloque.
 * Por eso se avanza de a una página, comprobando siempre contra el número que
 * la propia grilla marca como actual: pedir "página 87" a ciegas no es una
 * opción que el paginador ofrezca.
 */
import { SEL_EVAL, TIEMPOS_EVAL, URL_EVALUACIONES } from './config-eval.js';

/** Deja el listado cargado y en la página 1. */
export async function abrirListado(sesion) {
  await sesion.page.goto(URL_EVALUACIONES, { waitUntil: 'domcontentloaded' });
  await sesion.esperarPostback();
  await sesion.page.waitForSelector(SEL_EVAL.listado.grid, { timeout: TIEMPOS_EVAL.esperaPaginacion });
}

/**
 * Lee las filas de datos de la página actual.
 *
 * El índice que se devuelve es el que usa el `Select$N` del onclick, no la
 * posición en la tabla: la fila 0 del DOM es el encabezado y la última es el
 * paginador, y confundirlos abriría la evaluación equivocada.
 *
 * @returns {Promise<Array<{indiceSelect:number, nivel:string, region:string,
 *   grupo:string, fecha:string, medicion:string, estadoEval:string,
 *   progreso:{completadas:number,total:number,crudo:string}}>>}
 */
export function leerFilas(page) {
  return page.evaluate((selFila) => {
    const NBSP = String.fromCharCode(160);
    const limpiar = (t) => (t ?? '').split(NBSP).join(' ').replace(/\s+/g, ' ').trim();

    return [...document.querySelectorAll(selFila)].map((fila) => {
      const celdas = [...fila.cells].map((c) => limpiar(c.innerText));
      const onclick = fila.getAttribute('onclick') ?? '';
      const m = onclick.match(/Select\$(\d+)/);
      const progresoCrudo = celdas[6] ?? '';
      const partes = progresoCrudo.match(/(\d+)\s*\/\s*(\d+)/);

      return {
        indiceSelect: m ? Number(m[1]) : -1,
        nivel: celdas[0] ?? '',
        region: celdas[1] ?? '',
        grupo: celdas[2] ?? '',
        fecha: celdas[3] ?? '',
        medicion: celdas[4] ?? '',
        estadoEval: celdas[5] ?? '',
        progreso: {
          completadas: partes ? Number(partes[1]) : 0,
          // El total es el número de evaluados: sirve para saber si vale la
          // pena abrir el detalle y para verificar que el parseo no perdió a
          // nadie.
          total: partes ? Number(partes[2]) : 0,
          crudo: progresoCrudo,
        },
      };
    });
  }, SEL_EVAL.listado.fila);
}

/**
 * Número de página que la grilla marca como actual.
 *
 * En el paginador de GridView la página actual es un `<span>` sin enlace,
 * mientras que las demás son `<a>`. Ésa es la única marca fiable: no hay
 * ningún control que publique el número.
 */
export function paginaActual(page) {
  return page.evaluate((selGrid) => {
    const grid = document.querySelector(selGrid);
    if (!grid) return 0;
    for (const span of grid.querySelectorAll('span')) {
      const n = Number((span.textContent ?? '').trim());
      if (Number.isInteger(n) && n > 0) return n;
    }
    // Sin paginador (una sola página de resultados) seguimos en la primera.
    return 1;
  }, SEL_EVAL.listado.grid);
}

/** Números de página que el paginador ofrece ahora mismo. */
function paginasOfrecidas(page) {
  return page.evaluate((selPag) =>
    [...document.querySelectorAll(selPag)]
      .map((a) => {
        const m = (a.getAttribute('href') ?? '').match(/Page\$(\d+)/);
        return m ? Number(m[1]) : null;
      })
      .filter((n) => n !== null)
  , SEL_EVAL.listado.paginador);
}

/**
 * Avanza a la página siguiente.
 *
 * Si el número concreto está en la ventana del paginador se pulsa directo. Si
 * no está —porque la ventana termina en la página actual— se pulsa el enlace
 * de mayor número, que es el que salta al bloque siguiente. Después se verifica
 * contra `paginaActual`: el paginador puede no moverse y quedarse callado, y
 * eso repetiría una página entera o cortaría el recorrido en silencio.
 *
 * @returns {Promise<{avanzo:boolean, pagina:number, motivo?:string}>}
 */
export async function siguientePagina(sesion) {
  const page = sesion.page;
  const actual = await paginaActual(page);
  const objetivo = actual + 1;
  const ofrecidas = await paginasOfrecidas(page);

  if (!ofrecidas.length) {
    return { avanzo: false, pagina: actual, motivo: 'el paginador no ofrece más páginas' };
  }

  // El salto de bloque ("...") es el enlace de número más alto.
  const destino = ofrecidas.includes(objetivo) ? objetivo : Math.max(...ofrecidas);
  if (destino <= actual) {
    return { avanzo: false, pagina: actual, motivo: 'no hay páginas por delante' };
  }

  await page.click(`${SEL_EVAL.listado.paginador}[href*="Page$${destino}"]`);
  await sesion.esperarPostback();
  await page
    .waitForFunction(
      (args) => {
        const grid = document.querySelector(args.selGrid);
        if (!grid) return false;
        for (const span of grid.querySelectorAll('span')) {
          const n = Number((span.textContent ?? '').trim());
          if (Number.isInteger(n) && n > 0) return n !== args.previa;
        }
        return false;
      },
      { selGrid: SEL_EVAL.listado.grid, previa: actual },
      { timeout: TIEMPOS_EVAL.esperaPaginacion, polling: 250 }
    )
    .catch(() => {});

  const nueva = await paginaActual(page);
  return nueva > actual
    ? { avanzo: true, pagina: nueva }
    : { avanzo: false, pagina: nueva, motivo: `el paginador no se movió de la página ${actual}` };
}

/**
 * Lleva el listado a una página concreta desde la primera.
 *
 * Hace falta para reanudar: el paginador sólo sabe avanzar por su ventana, así
 * que llegar a la 87 significa pasar por las 86 anteriores. Cuesta un postback
 * corto por página y sólo se paga una vez al arrancar.
 */
export async function irAPagina(sesion, objetivo, alAvanzar) {
  if (objetivo <= 1) return 1;

  let actual = await paginaActual(sesion.page);
  while (actual < objetivo) {
    const r = await siguientePagina(sesion);
    if (!r.avanzo) return actual;
    actual = r.pagina;
    alAvanzar?.(actual);
  }
  return actual;
}
