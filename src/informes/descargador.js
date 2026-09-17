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
 * Marca del informe completo. El esqueleto se titula sólo "REPORTE DE
 * DESEMPEÑO"; el bueno lleva "EVALUACIÓN 360" en la portada.
 */
const MARCA_INFORME = /REPORTE\s+EVALUACI[ÓO]N\s*360/i;

/** Rastro de la página de error de ASP.NET dentro del PDF. */
const MARCA_ERROR = /Server Error in|Exception Details|does not belong to table/i;

/** El servidor tarda entre uno y tres minutos en armar cada informe. */
export const TIMEOUT_DESCARGA = 600_000;

/**
 * ¿El PDF descargado es el informe completo?
 *
 * Se mira dentro del binario en latin1: los flujos de un PDF van comprimidos,
 * pero el texto de la portada de éstos aparece en claro, y basta para
 * distinguir las tres cosas que puede devolver el servidor.
 *
 * @returns {{valido:boolean, motivo?:string}}
 */
export function validarInforme(cuerpo) {
  if (cuerpo.subarray(0, FIRMA_PDF.length).toString('latin1') !== FIRMA_PDF) {
    return { valido: false, motivo: 'la respuesta no es un PDF' };
  }

  const texto = cuerpo.toString('latin1');

  if (MARCA_ERROR.test(texto)) {
    return { valido: false, motivo: 'el PDF contiene una página de error de la aplicación' };
  }
  if (!MARCA_INFORME.test(texto)) {
    return {
      valido: false,
      motivo:
        'el PDF no es el informe completo (falta "REPORTE EVALUACIÓN 360"): ' +
        'la sesión no tenía abierto el detalle de la evaluación',
    };
  }
  return { valido: true };
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
      const { valido, motivo } = validarInforme(cuerpo);

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
            },
            null,
            2
          )
        );

        return { ok: true, archivo, bytes: cuerpo.length };
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
