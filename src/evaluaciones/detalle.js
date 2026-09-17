/**
 * Detalle de una evaluación: la tabla de evaluados y sus evaluadores.
 *
 * Estructura real de #MainContent_gdv_Personas:
 *
 *   Evaluados | Area | Evaluadores | Acciones
 *
 * La celda "Evaluados" no es texto plano, viene marcada:
 *
 *   <h6><small>Luis Hernando Pabón Lizcano</small></h6>
 *   <ul><li><small>Sub Jefe de Comunidad</small></li>
 *       <li><small>lpabonl@gmail.com</small></li></ul>
 *
 * Leer su `innerText` da las tres cosas pegadas y sin separador fiable, así que
 * se parsea por estructura. El email sale de ahí, y es la mejor llave de match
 * que tiene esta página: en la colección `perfiles` es único al 99,9%.
 *
 * La columna "Evaluadores" contiene una tabla anidada por evaluado:
 *
 *   icono | nombre | cargo | estado | botón
 *
 * El icono es la ÚNICA pista del tipo de relación. No hay texto que lo diga.
 *
 * Y la grilla pagina cada diez evaluados, con dos consecuencias que costaron
 * datos antes de detectarse y que explican casi todo el código de espera de
 * este archivo: ver `recorrerPersonas` y `esperarContenidoEstable`.
 */
import { SEL_EVAL, TIEMPOS_EVAL, RELACIONES } from './config-eval.js';

/** La evaluación no tiene personas: la aplicación no renderiza la tabla. */
export class DetalleVacio extends Error {}

/** Tope defensivo: ninguna evaluación real tiene cientos de páginas de gente. */
const MAX_PAGINAS_PERSONAS = 50;

/**
 * Huella del contenido visible de la grilla de personas.
 *
 * Sirve para distinguir "la tabla ya está" de "la tabla es OTRA". Compara el
 * número de página junto con los nombres, porque el conteo de filas por sí solo
 * no alcanza: dos páginas consecutivas suelen tener las mismas diez filas y un
 * repintado a medias produce estados intermedios que parecen estables.
 */
function firmaContenido(page) {
  return page
    .evaluate((sel) => {
      const tabla = document.querySelector(sel);
      if (!tabla) return '';
      const NBSP = String.fromCharCode(160);
      const limpiar = (t) => (t ?? '').split(NBSP).join(' ').replace(/\s+/g, ' ').trim();

      const filaPager = [...tabla.rows].find((f) => f.querySelector('a[href*="Page$"]'));
      let pagina = 1;
      if (filaPager) {
        for (const span of filaPager.querySelectorAll('span')) {
          const n = Number((span.textContent ?? '').trim());
          if (Number.isInteger(n) && n > 0) { pagina = n; break; }
        }
      }

      const nombres = [...tabla.rows]
        .filter((f) => f.querySelector('[id*="imgBtn_Informe_Persona"]'))
        .map((f) => limpiar(f.cells[0]?.querySelector('h6')?.innerText));

      return nombres.length ? `p${pagina}:${nombres.join('|')}` : '';
    }, SEL_EVAL.detalle.personas)
    .catch(() => '');
}

/**
 * Espera a que la grilla muestre contenido NUEVO y ya terminado de pintar.
 *
 * Dos condiciones, y las dos hacen falta:
 *
 *   1. Que la huella sea distinta de la que había antes de la acción. Sin esto
 *      se lee la tabla de la evaluación anterior, que sigue en pantalla porque
 *      el detalle se dibuja debajo del listado y nadie la borra.
 *
 *   2. Que la huella se repita durante varios sondeos. Sin esto se lee una
 *      tabla a medio repintar: al paginar, la grilla pasa por estados en los
 *      que conviven filas de la página vieja con las de la nueva, y una lectura
 *      ahí devuelve personas duplicadas. Se vio de verdad —una evaluación de 14
 *      devolvió 19 evaluados con sólo 14 informes distintos— y no produce
 *      ningún error: los duplicados entran como si fueran gente.
 *
 * @param {string} previa huella anterior a la acción
 * @returns {Promise<boolean>} false si venció el tiempo sin contenido nuevo
 */
async function esperarContenidoEstable(page, previa, timeout) {
  const sondeo = 500;
  const repeticionesRequeridas = 4;
  const limite = Date.now() + timeout;

  let ultima = null;
  let iguales = 0;

  while (Date.now() < limite) {
    await page.waitForTimeout(sondeo);
    const actual = await firmaContenido(page);

    // Vacía o todavía igual a la de antes: no hay nada nuevo que estabilizar.
    if (!actual || actual === previa) {
      iguales = 0;
      ultima = null;
      continue;
    }

    if (actual === ultima) {
      if (++iguales >= repeticionesRequeridas) return true;
    } else {
      iguales = 0;
      ultima = actual;
    }
  }

  return false;
}

/**
 * Selecciona una fila del listado y despliega su detalle.
 *
 * Cuando una evaluación no tiene personas, `gdv_Personas` NO EXISTE: no se
 * pinta una tabla vacía ni un mensaje, simplemente no está. Es el mismo
 * comportamiento del listado de hojas de vida de la etapa 1, y por eso el
 * vencimiento del plazo se trata como "vacía" y no como fallo.
 *
 * La tabla vieja se borra del DOM antes de pedir la nueva. Borrarla no toca
 * ningún dato: es la copia que este navegador tiene en pantalla, y el postback
 * la reconstruye. Sin ese borrado, "la tabla existe" se cumple al instante con
 * los datos de la evaluación anterior.
 *
 * @param {number} indiceSelect índice del `Select$N` de la fila
 */
export async function abrirDetalle(sesion, indiceSelect, { espera } = {}) {
  const page = sesion.page;

  await page.click(`${SEL_EVAL.listado.fila}[onclick*="Select$${indiceSelect}"]`);
  await sesion.esperarPostback();

  await page.evaluate((sel) => document.querySelector(sel)?.remove(), SEL_EVAL.detalle.personas);

  await sesion.clickEval(SEL_EVAL.listado.buscar);

  const apareció = await esperarContenidoEstable(page, '', espera ?? TIEMPOS_EVAL.esperaDetalle);
  if (!apareció) {
    throw new DetalleVacio(
      'gdv_Personas no apareció: la evaluación no tiene personas, o el servidor no respondió'
    );
  }
}

/**
 * Página actual de la grilla de personas.
 *
 * El paginador sigue la misma convención que el del listado: la página en curso
 * es un `<span>` y las demás son enlaces. Sin paginador hay una sola página.
 */
export function paginaActualPersonas(page) {
  return page.evaluate((sel) => {
    const tabla = document.querySelector(sel);
    if (!tabla) return 0;
    const filaPager = [...tabla.rows].find((f) => f.querySelector('a[href*="Page$"]'));
    if (!filaPager) return 1;
    for (const span of filaPager.querySelectorAll('span')) {
      const n = Number((span.textContent ?? '').trim());
      if (Number.isInteger(n) && n > 0) return n;
    }
    return 1;
  }, SEL_EVAL.detalle.personas);
}

/**
 * Salta a una página concreta de la grilla de personas.
 *
 * El éxito se mide por que el CONTENIDO haya cambiado, no por que el paginador
 * declare el número esperado. Exigir esa igualdad dejó fuera a una evaluación de
 * once personas: el salto a la segunda página funcionó, pero la comprobación no
 * lo dio por bueno y el recorrido se cortó en diez, que es justo el tamaño de
 * página y por tanto un resultado de aspecto inocente.
 *
 * @returns {Promise<boolean>} true si la grilla muestra contenido nuevo
 */
async function irAPaginaPersonas(sesion, objetivo) {
  const page = sesion.page;
  const enlace = `${SEL_EVAL.detalle.personas} a[href*="Page$${objetivo}"]`;
  if ((await page.locator(enlace).count()) === 0) return false;

  const previa = await firmaContenido(page);
  await page.click(enlace);
  await sesion.esperarPostback();

  return esperarContenidoEstable(page, previa, TIEMPOS_EVAL.esperaDetalle);
}

/**
 * Recorre todas las páginas de evaluados de la evaluación abierta.
 *
 * Empieza asegurándose de estar en la primera página, y no es una precaución
 * teórica: el índice de página de esta grilla lo guarda el servidor y sobrevive
 * al cambio de evaluación. Tras paginar una evaluación de catorce personas, la
 * siguiente abría directamente en su página dos y devolvía dos evaluados de
 * doce, sin error y sin aviso.
 *
 * `porPagina` se llama una vez por página con los evaluados de esa página,
 * mientras esa página está en pantalla. Importa que sea así: los botones de
 * informe se renumeran desde cero en cada página, de modo que cosechar sus URLs
 * sólo es correcto en ese momento.
 *
 * @param {(personas:Array, pagina:number) => Promise<Array>} porPagina
 * @returns {Promise<{personas:Array, paginas:number}>}
 */
export async function recorrerPersonas(sesion, porPagina, { esperados = 0 } = {}) {
  const acumulado = [];
  /** Los ids de botón ya vistos: red de seguridad contra lecturas repetidas. */
  const vistas = new Set();
  let paginas = 0;
  let pasadas = 0;

  /** Una vuelta completa por todas las páginas de la grilla. */
  async function recorrerUnaVez() {
    if ((await paginaActualPersonas(sesion.page)) !== 1) {
      await irAPaginaPersonas(sesion, 1);
    }

    for (let vuelta = 0; vuelta < MAX_PAGINAS_PERSONAS; vuelta++) {
      const pagina = await paginaActualPersonas(sesion.page);
      const personas = await leerPersonas(sesion.page);
      if (pasadas === 0) paginas++;

      const procesadas = await porPagina(personas, pagina);
      for (const persona of procesadas) {
        // La clave es la de la propia aplicación cuando está disponible: dos
        // lecturas de la misma persona traen el mismo id de informe, así que
        // repetir el recorrido no puede duplicar a nadie.
        const clave = persona.informe?.id ?? `${pagina}#${persona.indice}#${persona.nombre}`;
        if (vistas.has(clave)) continue;
        vistas.add(clave);
        acumulado.push(persona);
      }

      if (!(await irAPaginaPersonas(sesion, pagina + 1))) break;
    }
    pasadas++;
  }

  await recorrerUnaVez();

  // Segunda pasada cuando falta gente respecto de lo que declara el listado.
  //
  // Se vio que una página interna puede leerse a medio pintar pese a la espera
  // de estabilidad —una evaluación de catorce devolvió doce—, y el resultado no
  // se distingue de uno correcto salvo por ese contador. Como la deduplicación
  // usa el id del informe, volver a pasar sólo puede añadir lo que falte, nunca
  // repetir. Cuesta unos segundos y sólo se paga cuando hay motivo.
  if (esperados > 0 && acumulado.length < esperados) {
    await recorrerUnaVez();
  }

  return { personas: acumulado, paginas, pasadas };
}

/**
 * Lee los evaluados y sus evaluadores de la página visible.
 * No toca nada: sólo lectura del DOM.
 */
export function leerPersonas(page) {
  return page.evaluate((args) => {
    const { selFilas, relaciones } = args;
    const NBSP = String.fromCharCode(160);
    const limpiar = (t) => (t ?? '').split(NBSP).join(' ').replace(/\s+/g, ' ').trim();
    const oNulo = (t) => (limpiar(t) === '' ? null : limpiar(t));

    /** Traduce la clase del icono a un tipo de relación conocido. */
    const relacionDe = (clases) => {
      for (const [icono, nombre] of Object.entries(relaciones)) {
        if (clases.includes(icono)) return nombre;
      }
      return null;
    };

    /**
     * La celda del evaluado: nombre en el h6, y en la lista el cargo y el
     * email. El email se reconoce por la arroba en vez de por su posición,
     * porque un evaluado sin correo dejaría un solo <li> y correrían todos.
     */
    const leerEvaluado = (celda) => {
      const nombre = oNulo(celda.querySelector('h6')?.innerText);
      const items = [...celda.querySelectorAll('li')].map((li) => limpiar(li.innerText)).filter(Boolean);
      const email = items.find((t) => t.includes('@')) ?? null;
      const cargo = items.find((t) => !t.includes('@')) ?? null;
      return { nombre, cargo, email: email ? email.toLowerCase() : null };
    };

    /** La tabla anidada de evaluadores de un evaluado. */
    const leerEvaluadores = (celda) => {
      const tabla = celda.querySelector('table[id*="gdv_Evaluadores"]');
      if (!tabla) return [];

      return [...tabla.rows]
        .map((fila) => {
          const celdas = [...fila.cells];
          if (celdas.length < 4) return null;

          const clases = [...celdas[0].querySelectorAll('span,i')].map((n) => n.className).join(' ');

          return {
            relacion: relacionDe(clases),
            // Se guarda el icono crudo: si mañana aparece una relación nueva,
            // queda registrada en vez de perderse como null.
            iconoCrudo: limpiar(clases) || null,
            nombre: oNulo(celdas[1].innerText),
            cargo: oNulo(celdas[2].innerText),
            estado: oNulo(celdas[3].innerText),
          };
        })
        .filter((e) => e && e.nombre);
    };

    // Una fila es de datos si trae botón de informe. Ni el encabezado ni la
    // fila de paginación lo tienen, así que no hay que contar posiciones ni
    // suponer dónde cae cada cosa.
    return [...document.querySelectorAll(selFilas)]
      .map((fila) => {
        const boton = fila.querySelector('[id*="imgBtn_Informe_Persona"]');
        if (!boton) return null;

        const celdas = [...fila.cells];
        if (celdas.length < 3) return null;
        const { nombre, cargo, email } = leerEvaluado(celdas[0]);
        if (!nombre) return null;

        // El índice se lee del id del botón, no de la posición de la fila: es
        // el número que hay que usar para pedir el informe, y en la segunda
        // página de evaluados vuelve a empezar en cero.
        const m = boton.id.match(/imgBtn_Informe_Persona_(\d+)$/);

        return {
          indice: m ? Number(m[1]) : null,
          nombre,
          cargo,
          email,
          area: oNulo(celdas[1].innerText),
          evaluadores: leerEvaluadores(celdas[2]),
        };
      })
      .filter((e) => e && e.indice !== null);
  }, { selFilas: SEL_EVAL.detalle.filasPersonas, relaciones: RELACIONES });
}
