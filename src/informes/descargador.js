/**
 * Descarga de los informes PDF (etapa 2, fase 2).
 *
 * La lección que da forma a este módulo: **la URL no basta**.
 *
 * Un GET a `informe_Desemp.aspx?id=…&group=…&cargo=…` con una cookie válida
 * responde HTTP 200 y devuelve un PDF perfectamente formado… de 110 KB,
 * titulado "REPORTE DE DESEMPEÑO" y sin un solo dato de la persona. El informe
 * de verdad pesa entre 350 KB y 900 KB y lleva el nombre en la portada.
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
 * Quién decide si un PDF vale está en `validador.js`, con su banco de pruebas.
 *
 * NADA DE LO QUE SE RECHAZA SE TIRA
 *
 * Lo rechazado se guarda en `<destino>/cuarentena/` con un JSON que dice
 * cuántas páginas traía, cuánto pesaba, cuánto tardó el servidor en armarlo y
 * por qué se rechazó. No es celo de archivero: la primera versión de este
 * filtro borraba lo que descartaba, y cuando hubo que revisar si se estaban
 * perdiendo informes buenos —se estaban perdiendo— no quedaba un solo archivo
 * que mirar. Un filtro que decide qué datos son buenos y destruye lo que
 * descarta es un filtro que no se puede auditar nunca.
 *
 * El tiempo que tardó es además señal de primera: el esqueleto vacío llega en
 * uno a tres segundos, mientras que un informe de verdad le cuesta al servidor
 * entre uno y dos minutos. Un PDF que costó 104 segundos no es una plantilla.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { validarInforme } from './validador.js';

export { contarPaginas, validarInforme } from './validador.js';

/** El servidor tarda entre uno y tres minutos en armar cada informe. */
export const TIMEOUT_DESCARGA = 600_000;

/** Subcarpeta donde acaba todo lo que no pasó la validación. */
export const CARPETA_CUARENTENA = 'cuarentena';

/** Guarda un PDF junto a un hermano JSON que dice de quién es y qué es. */
async function guardar(carpeta, informe, cuerpo, extra) {
  await mkdir(carpeta, { recursive: true });
  const archivo = join(carpeta, `${informe.id}.pdf`);
  await writeFile(archivo, cuerpo);
  await writeFile(
    join(carpeta, `${informe.id}.json`),
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
        ...extra,
      },
      null,
      2
    )
  );
  return archivo;
}

/**
 * Pide un informe y lo guarda: el bueno en `destino`, el que no pasa en
 * `destino/cuarentena`.
 *
 * El 500 de esta página suele ser transitorio: aparece al pedir un informe
 * mientras el servidor sigue ocupado con el anterior de la misma sesión. Se
 * comprobó con un informe que devolvió 500 y bajó sin problema al reintentar,
 * así que se reintenta con pausa creciente en vez de darlo por perdido.
 *
 * @param {{request:Object}} sesion
 * @param {{url:string, id:string, nombre?:string, documento?:string}} informe
 * @param {string} destino carpeta de salida
 * @returns {Promise<{ok:boolean, archivo?:string, bytes?:number, paginas?:number,
 *   ms?:number, motivo?:string, cuarentena?:string}>}
 */
export async function descargarInforme(sesion, informe, destino, { intentos = 3 } = {}) {
  let ultimoFallo = 'sin intento';

  for (let intento = 1; intento <= intentos; intento++) {
    let respuesta = null;
    const inicio = Date.now();
    try {
      respuesta = await sesion.request.get(informe.url, { timeout: TIMEOUT_DESCARGA });
    } catch (error) {
      ultimoFallo = `petición fallida: ${error.message}`;
    }

    if (respuesta?.ok()) {
      const cuerpo = await respuesta.body();
      const ms = Date.now() - inicio;
      const { valido, motivo, paginas, dudoso } = await validarInforme(cuerpo, {
        nombre: informe.nombre,
      });

      if (valido) {
        // El nombre sale del `id`, único por persona Y evaluación: así las N
        // evaluaciones de una misma persona nunca se pisan.
        const archivo = await guardar(destino, informe, cuerpo, { paginas, ms, ...(dudoso && { dudoso }) });
        return { ok: true, archivo, bytes: cuerpo.length, paginas, ms, dudoso };
      }

      // Rechazado: se guarda igual, con el diagnóstico completo. Que el filtro
      // se equivoque es cuestión de tiempo; que no se pueda comprobar, no.
      const cuarentena = await guardar(join(destino, CARPETA_CUARENTENA), informe, cuerpo, {
        paginas,
        ms,
        rechazadoPor: motivo,
      });

      // Un PDF inválido no mejora reintentando: o falta estado de sesión, o la
      // evaluación no tiene datos suficientes para armar el informe.
      return { ok: false, motivo, paginas, bytes: cuerpo.length, ms, cuarentena };
    }

    if (respuesta) ultimoFallo = `HTTP ${respuesta.status()}`;
    if (intento < intentos) await new Promise((r) => setTimeout(r, 5000 * intento));
  }

  return { ok: false, motivo: `${ultimoFallo} tras ${intentos} intento(s)` };
}
