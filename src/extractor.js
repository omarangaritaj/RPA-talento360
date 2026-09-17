/**
 * Extracción de una hoja de vida de HojaDeVida.aspx.
 *
 * La página expone la información de tres formas distintas, y cada una necesita
 * su propio tratamiento:
 *
 * 1. Campos simples — inputs, selects y textareas con los datos personales.
 * 2. Repeaters — listas de ASP.NET cuyos ids siguen el patrón
 *    `MainContent_<Repeater>_<Lbl_Campo>_<índice>`. Se detectan por patrón en
 *    vez de por lista fija: así se capturan también las secciones que ningún
 *    perfil de muestra tenía pobladas.
 * 3. GridViews — dos tablas HTML (cargos y vínculos familiares).
 */
import { SEL, TIEMPOS, PREFIJOS_MODALES, CAMPOS_FORMULARIO_ALTA, PLACEHOLDERS, URLS, ESTADOS_LISTADO } from './config.js';

/**
 * Pulsa los "Mostrar Más" hasta agotarlos.
 *
 * Cada sección pagina por su cuenta y no informa cuántas páginas quedan: el
 * botón sigue visible aunque ya no haya nada más que traer. El criterio de
 * parada es que el número de elementos del repeater deje de crecer.
 *
 * @returns {Promise<Object>} clics efectivos por sección
 */
export async function expandirTodo(sesion) {
  const page = sesion.page;
  const resumen = {};

  for (const { seccion, selector } of SEL.mostrarMas) {
    let clics = 0;

    for (let i = 0; i < TIEMPOS.maxClicsMostrarMas; i++) {
      const boton = page.locator(selector);
      const visible = (await boton.count()) > 0 && (await boton.isVisible().catch(() => false));
      if (!visible) break;

      const antes = await contarElementosRepeaters(page);
      await boton.click().catch(() => {});
      await sesion.esperarPostback();
      const despues = await contarElementosRepeaters(page);

      clics++;
      if (despues <= antes) break; // no llegó nada nuevo
    }
    resumen[seccion] = clics;
  }
  return resumen;
}

/** Total de labels indexados en la página: sirve de sonda de crecimiento. */
function contarElementosRepeaters(page) {
  return page
    .evaluate(() => document.querySelectorAll('span[id*="_Lbl_"], span[id*="_lbl_"]').length)
    .catch(() => 0);
}

/**
 * Lee la hoja de vida abierta y devuelve su contenido estructurado.
 * No modifica nada en la página.
 */
export async function extraerHojaVida(sesion) {
  return sesion.page.evaluate(({ prefijosModales, camposAlta, placeholders }) => {
    const limpiar = (v) => {
      const t = (v ?? '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
      // La aplicación deja "Seleccione" y variantes en los combos sin elegir.
      return !t || placeholders.includes(t) ? null : t;
    };

    // Se descartan tanto los modales de alta como los formularios embebidos de
    // "agregar cargo" y "agregar vínculo familiar": están siempre vacíos.
    const esDeFormulario = (id) =>
      prefijosModales.some((p) => id.startsWith(p)) || camposAlta.includes(id);

    // ---- 1. campos simples -------------------------------------------------
    const campos = {};
    for (const el of document.querySelectorAll('input, select, textarea')) {
      const id = el.id;
      if (!id || !id.startsWith('MainContent_') || esDeFormulario(id)) continue;
      if (['hidden', 'submit', 'button', 'image', 'file'].includes(el.type)) continue;

      const clave = id
        .replace(/^MainContent_/, '')
        .replace(/^(txt_|Cbo_|rb_|Ckb_)/, '');

      if (el.type === 'radio') {
        // Sólo interesa el radio marcado; la clave es el grupo.
        if (el.checked) campos[el.name?.split('$').pop()?.replace(/^rb_/, '') ?? clave] = clave;
        continue;
      }
      if (el.type === 'checkbox') {
        campos[clave] = el.checked;
        continue;
      }
      if (el.tagName === 'SELECT') {
        // El value es un id interno; el usuario ve el texto de la opción.
        campos[clave] = limpiar(el.selectedOptions?.[0]?.text);
        continue;
      }
      campos[clave] = limpiar(el.value);
    }

    // ---- 2. repeaters ------------------------------------------------------
    // id = MainContent_<repeater>_<Lbl|lbl>_<campo>_<índice>
    const patron = /^MainContent_(.+?)_(?:Lbl|lbl)_(.+?)_(\d+)$/;
    const acumulador = {};

    for (const span of document.querySelectorAll('span[id]')) {
      const m = span.id.match(patron);
      if (!m) continue;
      const [, repeater, campo, indice] = m;
      if (esDeFormulario(span.id)) continue;

      acumulador[repeater] ??= {};
      acumulador[repeater][indice] ??= {};
      acumulador[repeater][indice][campo] = limpiar(span.innerText ?? span.textContent);
    }

    const repeaters = {};
    for (const [repeater, items] of Object.entries(acumulador)) {
      const lista = Object.keys(items)
        .sort((a, b) => Number(a) - Number(b))
        .map((i) => items[i])
        // Un item sin ningún valor es una fila en blanco del repeater.
        .filter((item) => Object.values(item).some(Boolean));
      if (lista.length) repeaters[repeater] = lista;
    }

    // ---- 3. gridviews ------------------------------------------------------
    const leerTabla = (id) => {
      const tabla = document.getElementById(id);
      if (!tabla || tabla.rows.length < 2) return [];
      const encabezados = [...tabla.rows[0].cells].map((c) => limpiar(c.innerText) ?? '');
      return [...tabla.rows]
        .slice(1)
        .map((fila) => {
          const objeto = {};
          [...fila.cells].forEach((celda, i) => {
            const clave = encabezados[i];
            // "Acciones" sólo contiene los botones de editar y eliminar.
            if (!clave || clave === 'Acciones') return;
            objeto[clave] = limpiar(celda.innerText);
          });
          return objeto;
        })
        .filter((o) => Object.values(o).some(Boolean));
    };

    // ---- 4. foto -----------------------------------------------------------
    // Hay dos imágenes de persona en la página: la del usuario que inició
    // sesión (foto_perfilAdministradores) y la de la ficha abierta. Sólo la
    // segunda corresponde al perfil que estamos extrayendo.
    const foto = document.getElementById('MainContent_foto_Perfil');

    return {
      campos,
      repeaters,
      cargos: leerTabla('MainContent_Gdv_CargosPersonas'),
      vinculosFamiliares: leerTabla('MainContent_Gdv_VincFamiliares'),
      fotoUrl: foto ? new URL(foto.getAttribute('src'), location.href).href : null,
      secciones: [...document.querySelectorAll('h2')].map((h) => h.innerText.trim()),
    };
  }, { prefijosModales: PREFIJOS_MODALES, camposAlta: CAMPOS_FORMULARIO_ALTA, placeholders: PLACEHOLDERS });
}

/**
 * Pone el filtro de estado del listado en "Todos".
 *
 * Sin esto el grid sólo muestra a los vinculados y el resto —aspirantes,
 * candidatos, desvinculados y bloqueados— se reporta como "sin resultados".
 *
 * Es idempotente: si el combo ya está en "Todos" no dispara el postback, que
 * cuesta un par de segundos por documento.
 *
 * @returns {Promise<{cambiado:boolean, valor:string|null}>}
 */
export async function filtrarTodosLosEstados(sesion) {
  const page = sesion.page;
  const combo = page.locator(ESTADOS_LISTADO.selector);

  if ((await combo.count()) === 0) {
    // Si el combo no está, el listado no lo filtra: nada que hacer.
    return { cambiado: false, valor: null };
  }

  const actual = await combo.inputValue();
  if (actual === ESTADOS_LISTADO.todos) return { cambiado: false, valor: actual };

  // Por value, no por texto: el rótulo es lo que cambia cuando la aplicación
  // se traduce o se renombra una opción.
  await combo.selectOption(ESTADOS_LISTADO.todos).catch(async (error) => {
    await combo.selectOption({ label: ESTADOS_LISTADO.etiquetaTodos }).catch(() => {
      throw error;
    });
  });
  // El onchange del combo es un __doPostBack: el grid se rearma antes de que
  // tenga sentido escribir en el buscador.
  await sesion.esperarPostback();

  return { cambiado: true, valor: await combo.inputValue() };
}

/**
 * Deja el listado cargado y filtrado por "Todos", listo para buscar.
 * @returns {Promise<{cambiado:boolean, valor:string|null}>}
 */
async function abrirListado(sesion) {
  await sesion.page.goto(URLS.adultos, { waitUntil: 'domcontentloaded' });
  await sesion.esperarPostback();
  // El filtro va ANTES de escribir: su onchange es un postback que repinta el
  // grid y limpiaría el buscador. Y cada goto lo devuelve a "Vinculado", así
  // que hay que fijarlo en cada documento.
  return filtrarTodosLosEstados(sesion);
}

/**
 * Busca un documento en el listado y devuelve cuántas filas trajo.
 *
 * Leer el conteo justo después del postback no es fiable: una de cada diez
 * búsquedas encuentra el grid todavía sin renderizar y devuelve cero, lo que
 * el RPA interpretaba como "este documento no existe". Aquí se espera de forma
 * activa a que aparezca al menos una fila, y si no aparece se repite la
 * búsqueda desde el listado recargado antes de darla por vacía.
 *
 * El grid ausente es la única señal de "sin resultados" que da la aplicación:
 * no pinta ningún mensaje, simplemente no renderiza la tabla. Por eso hace
 * falta agotar el tiempo de espera para concluir que algo no está.
 *
 * @returns {Promise<{filas:number, intentos:number, filtro:{valor:string|null}}>}
 */
export async function buscarDocumento(sesion, documento, { intentos = 2 } = {}) {
  const page = sesion.page;
  let filtro = { cambiado: false, valor: null };

  for (let intento = 1; intento <= intentos; intento++) {
    // El primer intento reutiliza el listado que ya dejó abierto el llamador;
    // los siguientes lo recargan, porque un grid que no pintó puede haberse
    // llevado por delante el resto del UpdatePanel.
    if (intento > 1) filtro = await abrirListado(sesion);

    await page.fill(SEL.listado.buscar, documento);
    await page.press(SEL.listado.buscar, 'Enter');
    await sesion.esperarPostback();

    const filas = await page
      .waitForSelector(SEL.listado.filaSeleccionable, { timeout: TIEMPOS.esperaGridResultados })
      .then(() => page.locator(SEL.listado.filaSeleccionable).count())
      .catch(() => 0);

    if (filas > 0) return { filas, intentos: intento, filtro };
  }

  return { filas: 0, intentos, filtro };
}

/**
 * Flujo completo para una cédula: filtrar, buscar, abrir, expandir y extraer.
 * @returns {Promise<{encontrado:boolean, datos?:Object, expansiones?:Object}>}
 */
export async function procesarDocumento(sesion, documento) {
  const page = sesion.page;

  let filtro = await abrirListado(sesion);
  const busqueda = await buscarDocumento(sesion, documento);
  filtro = busqueda.filtro.valor ? busqueda.filtro : filtro;
  const filas = busqueda.filas;

  if (filas === 0) {
    // Con el filtro en "Todos" y tras agotar los reintentos, un cero aquí sí
    // significa que el documento no está en la aplicación.
    return {
      encontrado: false,
      motivo:
        `sin resultados en el buscador tras ${busqueda.intentos} intento(s) ` +
        `(filtro de estados = ${filtro.valor ?? 'sin combo'})`,
    };
  }

  await page.locator(SEL.listado.filaSeleccionable).first().click();
  await sesion.esperarPostback();

  await page.click(SEL.listado.editar);
  await sesion.esperarHojaVidaLista();

  const expansiones = await expandirTodo(sesion);
  const datos = await extraerHojaVida(sesion);

  // El buscador es por coincidencia: confirmamos que abrimos la ficha correcta.
  const documentoEnFicha = datos.campos?.Documento ?? null;
  if (documentoEnFicha && documentoEnFicha.replace(/\D/g, '') !== documento.replace(/\D/g, '')) {
    return {
      encontrado: false,
      motivo: `la ficha abierta es del documento ${documentoEnFicha}, no de ${documento}`,
    };
  }

  return {
    encontrado: true,
    datos,
    expansiones,
    filasEncontradas: filas,
    filtroEstados: filtro.valor,
    intentosBusqueda: busqueda.intentos,
  };
}
