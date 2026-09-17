/**
 * Cosecha de las URLs de los informes PDF.
 *
 * El botón de informe no es un enlace: dispara un postback cuya respuesta trae
 * un bloque de script con `window.open('../Formularios/informe_Desemp.aspx?
 * id=...&group=...&cargo=...','_blank')`. La URL nunca está en el DOM —buscar
 * esos números en el HTML da cero resultados— así que hay que provocar el
 * postback para conocerla.
 *
 * Lo que NO hay que hacer es dejar que la pestaña se abra: ver el comentario
 * en navegador-eval.js. Con `window.open` interceptado, cada URL cuesta ~330ms
 * en vez de ~160s.
 *
 * Sobre los parámetros, medidos en una evaluación de 8 personas:
 *   - `group` es constante dentro de la evaluación
 *   - `cargo` identifica el PUESTO, no a la persona: dos "Sub Jefe de Manada"
 *     distintos comparten cargo=381012
 *   - `id` es el único valor que identifica un informe sin ambigüedad, y no es
 *     correlativo (1730, 1644, 4791, 1668, 1540...). Es la llave del archivo.
 */
import { SEL_EVAL, TIEMPOS_EVAL } from './config-eval.js';

/** La intercepción de window.open no está puesta: cosechar abriría pestañas. */
export class ErrorInterceptorCaido extends Error {}

/**
 * Pide el informe de un evaluado y devuelve su URL.
 *
 * @returns {Promise<{url:string|null, id:string|null, group:string|null,
 *   cargo:string|null, ms:number, motivo?:string}>}
 */
export async function cosecharUrl(sesion, indice) {
  const page = sesion.page;
  const selector = SEL_EVAL.detalle.informe(indice);

  if ((await page.locator(selector).count()) === 0) {
    return { url: null, id: null, group: null, cargo: null, ms: 0, motivo: 'el botón no existe' };
  }

  const antes = (await sesion.urlsInforme()).length;
  const inicio = Date.now();
  await page.click(selector);

  // Espera activa a que el postback deposite la URL. Es corta a propósito: con
  // el interceptor puesto resuelve en tres décimas, y si tarda mucho más es
  // que algo va mal y conviene enterarse pronto.
  const limite = inicio + TIEMPOS_EVAL.esperaUrlInforme;
  let url = null;
  while (Date.now() < limite && url === null) {
    await page.waitForTimeout(TIEMPOS_EVAL.sondeoUrlInforme);
    const lista = await sesion.urlsInforme();
    if (lista.length > antes) url = lista[lista.length - 1];
  }

  const ms = Date.now() - inicio;
  if (!url) {
    return { url: null, id: null, group: null, cargo: null, ms, motivo: 'el postback no devolvió URL' };
  }

  let parametros = {};
  try {
    parametros = Object.fromEntries(new URL(url).searchParams);
  } catch {
    // Una URL ilegible se guarda igual: perderla sería perder el informe.
  }

  return {
    url,
    id: parametros.id ?? null,
    group: parametros.group ?? null,
    cargo: parametros.cargo ?? null,
    ms,
  };
}

/**
 * Cosecha las URLs de todos los evaluados del detalle abierto.
 *
 * Se comprueba el interceptor antes de empezar. Sin esa comprobación, un fallo
 * silencioso en la instalación convertiría la corrida en una cadena de
 * pestañas abiertas que bloquean la sesión: el síntoma sería una lentitud
 * inexplicable, no un error, y eso se descubre tarde y caro.
 *
 * @param {Array<{indice:number}>} evaluados
 */
export async function cosecharUrls(sesion, evaluados) {
  if (!(await sesion.interceptorActivo())) {
    throw new ErrorInterceptorCaido(
      'window.open no está interceptado en este documento: cosechar abriría pestañas ' +
        'y bloquearía la sesión durante minutos por cada informe'
    );
  }

  const resultados = [];
  for (const evaluado of evaluados) {
    resultados.push({ indice: evaluado.indice, ...(await cosecharUrl(sesion, evaluado.indice)) });
  }
  return resultados;
}
