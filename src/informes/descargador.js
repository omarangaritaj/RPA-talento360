/**
 * Descarga de los informes PDF (etapa 2, fase 2).
 *
 * La lección que da forma a este módulo: **la URL no basta**.
 *
 * Un GET a `informe_Desemp.aspx?id=…&group=…&cargo=…` con una cookie válida
 * responde HTTP 200 y devuelve un PDF perfectamente formado… de 110 KB,
 * titulado "REPORTE DE DESEMPEÑO" y sin un solo dato de la persona. El informe
 * de verdad pesa entre 200 KB y 900 KB, se titula "REPORTE EVALUACIÓN 360 DE
 * DESEMPEÑO" y lleva el nombre en la portada.
 *
 * La diferencia está en el estado de la sesión: el servidor sólo arma el
 * informe completo si esa sesión tiene ABIERTO EL DETALLE de la evaluación. Por
 * eso aquí no se descarga desde una sesión limpia: se recorre el listado, se
 * abre la evaluación y sólo entonces se piden los informes de su gente.
 *
 * Se comprobó además, pidiendo el informe de una persona tras pulsar el botón
 * de otra, que la URL sí manda sobre quién sale en el informe. Lo que la sesión
 * aporta es el contexto de la evaluación, no la identidad de la persona.
 *
 * Y una advertencia sobre la validación: comprobar la firma `%PDF-` NO alcanza.
 * Tanto el esqueleto vacío como la página de error de ASP.NET —que aparece como
 * `Column 'Promedio' does not belong to table`— llegan como PDF válidos. Doce
 * archivos se dieron por buenos antes de detectarlo.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** Un PDF de verdad empieza por esta firma. */
const FIRMA_PDF = '%PDF-';

/**
 * Rastro de la página de error de ASP.NET. Va en claro dentro del PDF, así que
 * se busca sobre el binario sin más.
 */
const MARCA_ERROR = /Server Error in|Exception Details|does not belong to table/i;

/**
 * Páginas mínimas para considerar que un informe trae datos.
 *
 * Medido sobre los dos tipos de respuesta: el informe completo tiene entre 37 y
 * 42 páginas; el esqueleto vacío, exactamente 10. El umbral va en medio y con
 * holgura hacia los dos lados.
 */
const MINIMO_PAGINAS = 20;

/** El servidor tarda entre uno y tres minutos en armar cada informe. */
export const TIMEOUT_DESCARGA = 600_000;

/**
 * Cuenta las páginas de un PDF.
 *
 * `/Type /Page` aparece una vez por página más una por el nodo `/Type /Pages`
 * que las agrupa, porque el primero es prefijo del segundo. Restando esa
 * aparición se obtiene el número exacto: comprobado contra pdfinfo en los dos
 * tipos de respuesta (43 marcas → 42 páginas, 11 → 10).
 *
 * Se cuenta a mano en vez de usar una librería porque es lo único que se
 * necesita del formato, y porque estos PDF son 1.4: los objetos de página van
 * sin comprimir y se pueden contar sobre el binario.
 */
export function contarPaginas(cuerpo) {
  const texto = cuerpo.toString('latin1');
  const todas = (texto.match(/\/Type\s*\/Pages?/g) ?? []).length;
  const agrupadores = (texto.match(/\/Type\s*\/Pages/g) ?? []).length;
  return todas - agrupadores;
}

/**
 * ¿El PDF descargado es un informe con datos?
 *
 * Tres cosas distintas llegan con HTTP 200 y firma `%PDF-` válida:
 *
 *   1. el informe de verdad: 37 a 42 páginas, entre 200 KB y 900 KB;
 *   2. un esqueleto de 10 páginas y ~110 KB, titulado sólo "REPORTE DE
 *      DESEMPEÑO" y sin un dato dentro, que es lo que devuelve el servidor
 *      cuando la sesión no tiene abierto el detalle de la evaluación;
 *   3. la página de error de ASP.NET maquetada como PDF.
 *
 * Se distinguen por el número de páginas. Dos caminos que parecían más
 * naturales no funcionan, y conviene dejarlo escrito para que nadie los repita:
 *
 * - Buscar el título en el binario NO sirve. El informe y el esqueleto comparten
 *   la misma plantilla incrustada: los dos contienen "REPORTE", "360" y los
 *   mismos identificadores de control.
 * - Descomprimir los flujos tampoco basta. El texto de un PDF va troceado por
 *   el ajuste entre caracteres —"REPORTE" puede quedar como `(R) 1 (EPORTE)`—
 *   así que una búsqueda literal falla aunque el texto esté ahí.
 *
 * Que el informe corresponda a la persona pedida está garantizado por la URL,
 * comprobado aparte: pedir el informe de una persona tras pulsar el botón de
 * otra devuelve igualmente el de la primera.
 *
 * @param {Buffer} cuerpo
 * @returns {{valido:boolean, paginas:number, motivo?:string}}
 */
export function validarInforme(cuerpo) {
  if (cuerpo.subarray(0, FIRMA_PDF.length).toString('latin1') !== FIRMA_PDF) {
    return { valido: false, paginas: 0, motivo: 'la respuesta no es un PDF' };
  }

  const paginas = contarPaginas(cuerpo);

  if (MARCA_ERROR.test(cuerpo.toString('latin1'))) {
    return { valido: false, paginas, motivo: 'el PDF contiene una página de error de la aplicación' };
  }

  if (paginas < MINIMO_PAGINAS) {
    return {
      valido: false,
      paginas,
      motivo:
        `el informe trae sólo ${paginas} página(s), por debajo de las ${MINIMO_PAGINAS} ` +
        'esperadas: es el esqueleto vacío, no el informe con datos',
    };
  }

  return { valido: true, paginas };
}

/**
 * Pide un informe y lo guarda si es el bueno.
 *
 * El 500 de esta página suele ser transitorio: aparece al pedir un informe
 * mientras el servidor sigue ocupado con el anterior de la misma sesión. Se
 * comprobó con un informe que devolvió 500 y bajó sin problema al reintentar,
 * así que se reintenta con pausa creciente en vez de darlo por perdido.
 *
 * @param {{request:Object}} sesion
 * @param {{url:string, id:string, nombre?:string, documento?:string}} informe
 * @param {string} destino carpeta de salida
 * @returns {Promise<{ok:boolean, archivo?:string, bytes?:number, motivo?:string}>}
 */
export async function descargarInforme(sesion, informe, destino, { intentos = 3 } = {}) {
  let ultimoFallo = 'sin intento';

  for (let intento = 1; intento <= intentos; intento++) {
    let respuesta = null;
    try {
      respuesta = await sesion.request.get(informe.url, { timeout: TIMEOUT_DESCARGA });
    } catch (error) {
      ultimoFallo = `petición fallida: ${error.message}`;
    }

    if (respuesta?.ok()) {
      const cuerpo = await respuesta.body();
      const { valido, motivo, paginas } = validarInforme(cuerpo);

      if (valido) {
        // El nombre sale del `id`, único por persona Y evaluación: así las N
        // evaluaciones de una misma persona nunca se pisan.
        const archivo = join(destino, `${informe.id}.pdf`);
        await mkdir(dirname(archivo), { recursive: true });
        await writeFile(archivo, cuerpo);

        // Un hermano con los datos de quién es: el PDF por sí solo no lo dice.
        await writeFile(
          join(destino, `${informe.id}.json`),
          JSON.stringify(
            {
              id: informe.id,
              url: informe.url,
              nombre: informe.nombre,
              documento: informe.documento,
              evaluacion: informe.medicion,
              grupo: informe.grupo,
              claveEvaluacion: informe.claveEvaluacion,
              descargadoEn: new Date().toISOString(),
              bytes: cuerpo.length,
              paginas,
            },
            null,
            2
          )
        );

        return { ok: true, archivo, bytes: cuerpo.length, paginas };
      }

      ultimoFallo = motivo;
      // Un PDF inválido no mejora reintentando: o falta estado de sesión, o la
      // evaluación no tiene datos suficientes para armar el informe.
      return { ok: false, motivo: ultimoFallo };
    }

    if (respuesta) ultimoFallo = `HTTP ${respuesta.status()}`;
    if (intento < intentos) await new Promise((r) => setTimeout(r, 5000 * intento));
  }

  return { ok: false, motivo: `${ultimoFallo} tras ${intentos} intento(s)` };
}
