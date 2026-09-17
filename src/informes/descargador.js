/**
 * Descarga de los informes PDF (etapa 2, fase 2).
 *
 * La fase 1 dejó en Mongo la URL de cada informe. Descargarlos es un GET normal
 * que sólo necesita la cookie de sesión, así que aquí no hace falta navegar
 * por la aplicación: se abre una sesión, se piden los archivos y se guardan.
 *
 * Lo que sí condiciona el diseño es el tiempo. El servidor GENERA el PDF en el
 * momento de la petición y tarda entre dos y cuatro minutos —medido: 872 KB en
 * 239 s—, y mientras tanto ASP.NET mantiene tomado el lock de esa sesión. Dos
 * descargas simultáneas sobre la misma sesión no van en paralelo: hacen cola.
 *
 * Por eso el paralelismo se consigue con VARIAS SESIONES, no con varias
 * peticiones. Cada worker abre su propio contexto de navegador y hace su propio
 * login, de modo que recibe una cookie distinta y, con ella, un lock distinto.
 * Funciona incluso con una sola credencial, porque lo que el servidor serializa
 * es la sesión, no la cuenta.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { chromium } from 'playwright';
import { URLS, SEL } from '../config.js';

/** Un PDF de verdad empieza por esta firma. Cualquier otra cosa es una página de error. */
const FIRMA_PDF = '%PDF-';

/** El servidor puede tardar minutos en generar el informe. */
export const TIMEOUT_DESCARGA = 600_000;

/**
 * Abre N sesiones independientes en un mismo navegador.
 *
 * Un contexto por worker: cookies separadas, sesiones separadas del lado del
 * servidor. Comparten proceso de Chromium, que es lo barato de compartir.
 *
 * @returns {Promise<{navegador:Object, sesiones:Array<{etiqueta:string, request:Object}>}>}
 */
export async function abrirSesiones(credencial, cantidad, { headless = true } = {}) {
  const navegador = await chromium.launch({
    headless,
    args: ['--disable-blink-features=AutomationControlled'],
  });

  const sesiones = [];
  for (let i = 1; i <= cantidad; i++) {
    const contexto = await navegador.newContext();
    const pagina = await contexto.newPage();

    await pagina.goto(URLS.login, { waitUntil: 'domcontentloaded' });
    await pagina.fill(SEL.login.usuario, credencial.usuario);
    await pagina.fill(SEL.login.password, credencial.password);
    await Promise.all([
      pagina.waitForLoadState('domcontentloaded'),
      pagina.click(SEL.login.enviar),
    ]);

    // El login fallido no avisa: devuelve al formulario.
    if (pagina.url().includes('inicio.aspx')) {
      await navegador.close().catch(() => {});
      throw new Error(`Login rechazado para "${credencial.usuario}" al abrir la sesión ${i}`);
    }

    // La página ya no hace falta: sólo queríamos la cookie en el contexto.
    await pagina.close().catch(() => {});
    sesiones.push({ etiqueta: `descarga-${i}`, request: contexto.request, contexto });
  }

  return { navegador, sesiones };
}

/**
 * Descarga un informe y lo guarda en disco.
 *
 * Se verifica la firma del archivo antes de darlo por bueno: cuando la sesión
 * caduca, el servidor responde 200 con el HTML del login, y guardar eso como
 * PDF dejaría miles de archivos corruptos que nadie detectaría hasta la etapa
 * 3. El cuerpo que no es PDF se conserva aparte para poder diagnosticarlo.
 *
 * @param {{url:string, id:string}} informe
 * @param {string} destino carpeta donde guardar
 * @returns {Promise<{ok:boolean, archivo?:string, bytes?:number, motivo?:string}>}
 */
export async function descargarInforme(sesion, informe, destino) {
  let respuesta;
  try {
    respuesta = await sesion.request.get(informe.url, { timeout: TIMEOUT_DESCARGA });
  } catch (error) {
    return { ok: false, motivo: `petición fallida: ${error.message}` };
  }

  if (!respuesta.ok()) {
    return { ok: false, motivo: `HTTP ${respuesta.status()}` };
  }

  const cuerpo = await respuesta.body();

  if (cuerpo.subarray(0, FIRMA_PDF.length).toString('latin1') !== FIRMA_PDF) {
    const tipo = respuesta.headers()['content-type'] ?? 'desconocido';
    const sospecha = cuerpo.toString('latin1', 0, 2000).includes('Txt_Usuario')
      ? ' (parece la página de login: la sesión caducó)'
      : '';
    // Se guarda la respuesta para poder mirarla, pero no como .pdf.
    const fallido = join(destino, `${informe.id}.no-es-pdf.html`);
    await mkdir(dirname(fallido), { recursive: true });
    await writeFile(fallido, cuerpo);
    return { ok: false, motivo: `la respuesta no es un PDF (${tipo}, ${cuerpo.length} b)${sospecha}` };
  }

  // El nombre sale del `id` del informe, que es único por persona y evaluación.
  // Así las N evaluaciones de una misma persona nunca se pisan.
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
