/**
 * ¿El PDF que llegó es el informe de esta persona?
 *
 * Vive aparte del descargador porque decidir qué datos son buenos tiene su
 * propia complejidad y merece su propio banco de pruebas: `pruebas/validador.test.mjs`.
 *
 * TRES COSAS DISTINTAS LLEGAN CON HTTP 200 Y FIRMA `%PDF-` VÁLIDA
 *
 *   1. El informe de verdad. Entre 23 y 42 páginas, de 350 KB a 900 KB. Lleva
 *      "ASOCIACION SCOUTS DE COLOMBIA" en la cabecera y el nombre del evaluado
 *      dos veces.
 *   2. El esqueleto vacío: exactamente 10 páginas y 109 KB, siempre idéntico.
 *      Es lo que devuelve el servidor cuando la sesión no tiene abierto el
 *      detalle de la evaluación. Comparte plantilla con el informe real, así
 *      que trae "REPORTE", "Competencia" y "Promedio" igual que él; lo que no
 *      trae es un solo dato de nadie.
 *   3. La página de error de ASP.NET maquetada como PDF.
 *
 * CÓMO SE DISTINGUEN — Y LOS DOS CAMINOS QUE NO FUNCIONAN
 *
 * Por el texto, buscando el nombre del evaluado. Verificado sobre las trece
 * muestras descargadas: aparece en 13 de 13 informes reales, y cero veces en
 * el esqueleto. Es la única comprobación que responde a la pregunta de verdad
 * —¿este PDF es el informe DE ESTA PERSONA?— en vez de a un sustituto suyo.
 *
 * Lo que NO funciona, y conviene dejarlo escrito para que nadie lo repita:
 *
 * - CONTAR PÁGINAS. Se probó con un mínimo de 20 y rechazó informes reales de
 *   14 y 15 páginas, uno de ellos con los siete evaluadores finalizados. El
 *   número de páginas depende de cuántos evaluadores respondieron: el informe
 *   más corto observado bajó de 37 a 23 según aparecieron evaluaciones
 *   pequeñas, y el umbral se quedó sin margen solo. No hay umbral bueno.
 * - BUSCAR TEXTO SOBRE EL BINARIO. El texto de un PDF va troceado por el
 *   ajuste entre caracteres —"REPORTE" puede quedar como `(R) 1 (EPORTE)`— así
 *   que una búsqueda literal falla aunque el texto esté ahí. Esto hizo creer
 *   en su momento que validar por texto era imposible, y era falso: lo
 *   imposible era hacerlo a mano. Un extractor de verdad lo reconstruye entero.
 *
 * De ahí la dependencia de `pdftotext` (poppler-utils), que ya hacía falta
 * para inspeccionar las muestras. Si no está, se avisa y se cae a una
 * heurística conservadora —descrita en `porFirmaDelEsqueleto`— que sólo
 * descarta lo que es idéntico al esqueleto conocido.
 */
import { execFile } from 'node:child_process';

/** Un PDF de verdad empieza por esta firma. */
const FIRMA_PDF = '%PDF-';

/**
 * Rastro de la página de error de ASP.NET. Va en claro dentro del PDF, así que
 * se busca sobre el binario sin más.
 */
const MARCA_ERROR = /Server Error in|Exception Details|does not belong to table/i;

/**
 * Cabecera que sólo aparece cuando el servidor armó el informe con datos. El
 * esqueleto empieza directamente por "DIRECCIÓN NACIONAL DE ADULTOS".
 * Es la red de seguridad para cuando no sabemos de quién debería ser el PDF.
 */
const MARCADOR_CABECERA = 'ASOCIACION SCOUTS DE COLOMBIA';

/** Páginas y peso del esqueleto vacío, medidos sobre dos muestras idénticas. */
const ESQUELETO = { paginas: 10, bytesMaximos: 150 * 1024 };

/**
 * Por debajo de esto, un informe se marca como DUDOSO. No se rechaza.
 *
 * Existe una tercera respuesta además del informe y el esqueleto, y se
 * descubrió tarde: el informe TRUNCADO. Sale cuando el servidor está armando
 * el PDF y otra sesión de la misma cuenta le pisa el estado; entrega lo que
 * llevaba hecho. El caso que lo destapó llegó con 15 páginas, y al repetirlo
 * con una sola sesión el mismo informe bajó con 42.
 *
 * Un truncado lleva el nombre del evaluado en la portada, así que pasa la
 * comprobación del texto igual que un informe entero. El número de páginas es
 * lo único que lo delata… y al mismo tiempo es señal MALÍSIMA para rechazar:
 * un informe legítimo de una evaluación pequeña puede tener 23 páginas, y no
 * hay forma de saber de antemano cuántas le tocan a cada uno.
 *
 * De ahí la asimetría, que es el punto entero de esta constante: el número de
 * páginas sirve para SOSPECHAR, nunca para DESCARTAR. Lo dudoso se guarda, se
 * marca en su JSON y se canta en el log para que alguien lo mire.
 */
const PAGINAS_SOSPECHOSAS = 20;

/** Margen para que `pdftotext` extraiga el texto. Sobra: tarda milisegundos. */
const TIMEOUT_EXTRACCION = 30_000;

/** Se avisa una sola vez por proceso, no una por informe. */
let avisadoSinPdftotext = false;

/**
 * Texto comparable: sin tildes, en mayúsculas y con los espacios colapsados.
 *
 * Hace falta a los dos lados. El nombre del listado y el del PDF vienen de la
 * misma base de datos, pero pasan por maquetaciones distintas y basta un salto
 * de línea entre el nombre y el apellido para que una comparación literal
 * falle.
 */
export function normalizar(texto) {
  return String(texto ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Cuenta las páginas de un PDF.
 *
 * `/Type /Page` aparece una vez por página más una por el nodo `/Type /Pages`
 * que las agrupa, porque el primero es prefijo del segundo. Restando esa
 * aparición se obtiene el número exacto: comprobado contra pdfinfo.
 *
 * Ya no decide nada —para eso está el texto— pero se sigue calculando porque
 * es diagnóstico gratis: queda en el JSON de cada informe y en el de cada
 * archivo en cuarentena, y es lo que permitió descubrir que el umbral de
 * páginas estaba mal.
 */
export function contarPaginas(cuerpo) {
  const texto = cuerpo.toString('latin1');
  const todas = (texto.match(/\/Type\s*\/Pages?/g) ?? []).length;
  const agrupadores = (texto.match(/\/Type\s*\/Pages/g) ?? []).length;
  return todas - agrupadores;
}

/**
 * Extrae el texto del PDF con `pdftotext`, pasándoselo por la entrada estándar
 * para no tener que escribir un temporal por informe.
 *
 * @returns {Promise<string|null>} null si pdftotext no está o falló
 */
export function extraerTexto(cuerpo) {
  return new Promise((resolve) => {
    const hijo = execFile(
      'pdftotext',
      ['-q', '-', '-'],
      { timeout: TIMEOUT_EXTRACCION, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' },
      (error, salida) => resolve(error ? null : salida)
    );
    hijo.on('error', () => resolve(null)); // pdftotext no instalado
    hijo.stdin.on('error', () => {}); // el hijo puede morir antes de leerlo todo
    hijo.stdin.end(cuerpo);
  });
}

/**
 * Plan B cuando no hay `pdftotext`.
 *
 * Deliberadamente tímida: sólo descarta lo que coincide con la firma exacta
 * del esqueleto —diez páginas y menos de 150 KB— y deja pasar todo lo demás.
 * Entre colar un esqueleto, que se detecta después mirando el archivo, y
 * tirar un informe que costó dos minutos de servidor y que nadie va a echar
 * en falta, el error caro es el segundo.
 */
function porFirmaDelEsqueleto(cuerpo, paginas) {
  if (paginas <= ESQUELETO.paginas && cuerpo.length < ESQUELETO.bytesMaximos) {
    return {
      valido: false,
      paginas,
      motivo:
        `coincide con la firma del esqueleto vacío (${paginas} página(s), ` +
        `${(cuerpo.length / 1024).toFixed(0)} KB) y no hay pdftotext para comprobar el texto`,
    };
  }
  return { valido: true, paginas, dudoso: true, motivo: 'aceptado sin comprobar el texto: falta pdftotext' };
}

/**
 * ¿Es éste el informe con datos de esta persona?
 *
 * @param {Buffer} cuerpo
 * @param {{nombre?:string}} referencia de quién debería ser el informe
 * @returns {Promise<{valido:boolean, paginas:number, motivo?:string, dudoso?:boolean}>}
 */
export async function validarInforme(cuerpo, { nombre } = {}) {
  if (cuerpo.subarray(0, FIRMA_PDF.length).toString('latin1') !== FIRMA_PDF) {
    return { valido: false, paginas: 0, motivo: 'la respuesta no es un PDF' };
  }

  const paginas = contarPaginas(cuerpo);

  if (MARCA_ERROR.test(cuerpo.toString('latin1'))) {
    return { valido: false, paginas, motivo: 'el PDF contiene una página de error de la aplicación' };
  }

  const texto = await extraerTexto(cuerpo);
  if (texto === null) {
    if (!avisadoSinPdftotext) {
      avisadoSinPdftotext = true;
      console.warn(
        'AVISO: no se pudo extraer el texto de los PDF (¿falta pdftotext, de poppler-utils?). ' +
          'Se valida por la firma del esqueleto, que es más burda. Instálalo: sudo apt install poppler-utils'
      );
    }
    return porFirmaDelEsqueleto(cuerpo, paginas);
  }

  const contenido = normalizar(texto);
  const buscado = normalizar(nombre);

  if (buscado && contenido.includes(buscado)) {
    // Es su informe. Falta saber si está entero: ver PAGINAS_SOSPECHOSAS.
    if (paginas < PAGINAS_SOSPECHOSAS) {
      return {
        valido: true,
        paginas,
        dudoso: true,
        motivo:
          `lleva el nombre del evaluado, así que es su informe, pero trae sólo ${paginas} ` +
          'página(s): podría estar truncado. Se guarda igual; compruébalo',
      };
    }
    return { valido: true, paginas };
  }

  // Sin nombre de referencia sólo queda preguntar si el informe trae datos de
  // alguien. Sirve para diagnosticar a mano un PDF suelto, no para la corrida.
  if (!buscado) {
    if (contenido.includes(normalizar(MARCADOR_CABECERA))) return { valido: true, paginas };
    return {
      valido: false,
      paginas,
      motivo: 'el PDF no lleva la cabecera de un informe con datos: es el esqueleto vacío',
    };
  }

  return {
    valido: false,
    paginas,
    motivo:
      `el PDF no contiene el nombre del evaluado ("${nombre}"), así que no es su informe: ` +
      `${paginas} página(s), ${(cuerpo.length / 1024).toFixed(0)} KB` +
      (contenido.includes(normalizar(MARCADOR_CABECERA))
        ? '. Lleva cabecera de informe con datos: podría ser de OTRA persona, revísalo en cuarentena'
        : '. Es el esqueleto vacío'),
  };
}
