/**
 * Banco de pruebas del validador de informes.
 *
 *   node --test pruebas/
 *
 * POR QUÉ ESTE ARCHIVO EXISTE
 *
 * El validador ya se equivocó tres veces seguidas, y cada vez en la misma
 * dirección: se calibró sobre una muestra demasiado pequeña.
 *
 *   1. Comprobar sólo la firma `%PDF-` dio por buenos doce esqueletos vacíos.
 *   2. Buscar el título en el binario rechazó informes correctos de 42 páginas.
 *   3. Exigir 20 páginas rechazó informes reales de 14 y 15 —uno de ellos con
 *      los siete evaluadores finalizados y 104 segundos de generación.
 *
 * Un filtro que decide qué datos son buenos necesita pruebas tanto como el
 * código que produce esos datos. Y contra archivos guardados, no contra el
 * servidor: iterar contra el servidor cuesta tres minutos por intento, contra
 * disco cuesta milisegundos.
 *
 * MUESTRAS
 *
 * Los esqueletos viven en `pruebas/muestras/` y van al repositorio: son
 * plantilla pura, sin un solo dato personal, y son la referencia negativa.
 * Los informes reales se leen de `informes/` —que está fuera del repositorio
 * porque sí lleva datos de personas— y las pruebas que los usan se saltan
 * solas si esa carpeta está vacía.
 */
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizar, validarInforme, contarPaginas } from '../src/informes/validador.js';

const AQUI = dirname(fileURLToPath(import.meta.url));
const MUESTRAS = join(AQUI, 'muestras');
const REALES = join(AQUI, '..', 'informes');

/** Informes reales con su nombre, leídos del hermano .json de cada PDF. */
async function informesReales() {
  let archivos = [];
  try {
    archivos = (await readdir(REALES)).filter((a) => a.endsWith('.pdf'));
  } catch {
    return [];
  }

  const casos = [];
  for (const archivo of archivos) {
    const id = archivo.replace(/\.pdf$/, '');
    try {
      const meta = JSON.parse(await readFile(join(REALES, `${id}.json`), 'utf8'));
      casos.push({ id, nombre: meta.nombre, cuerpo: await readFile(join(REALES, archivo)) });
    } catch {
      // Un PDF sin su .json no sirve de caso: no sabemos de quién es.
    }
  }
  return casos;
}

describe('normalizar', () => {
  test('quita las tildes y unifica mayúsculas y espacios', () => {
    assert.equal(normalizar('  Germán   David  Sosa Ramírez '), 'GERMAN DAVID SOSA RAMIREZ');
    assert.equal(normalizar('MYRIAM CARVAJAL DE PINEDA'), 'MYRIAM CARVAJAL DE PINEDA');
  });

  test('tolera nulos', () => {
    assert.equal(normalizar(null), '');
    assert.equal(normalizar(undefined), '');
  });
});

describe('contarPaginas', () => {
  test('cuenta bien el esqueleto conocido', async () => {
    const cuerpo = await readFile(join(MUESTRAS, 'esqueleto-vacio.pdf'));
    assert.equal(contarPaginas(cuerpo), 10);
  });
});

describe('validarInforme · rechaza lo que debe rechazar', () => {
  test('una respuesta que no es PDF', async () => {
    const r = await validarInforme(Buffer.from('<html>Error</html>'), { nombre: 'QUIEN SEA' });
    assert.equal(r.valido, false);
    assert.match(r.motivo, /no es un PDF/i);
  });

  test('la página de error de ASP.NET maquetada como PDF', async () => {
    const falso = Buffer.concat([
      Buffer.from('%PDF-1.4\n'),
      Buffer.from("Server Error in '/' Application. Column 'Promedio' does not belong to table"),
    ]);
    const r = await validarInforme(falso, { nombre: 'QUIEN SEA' });
    assert.equal(r.valido, false);
    assert.match(r.motivo, /error de la aplicación/i);
  });

  for (const muestra of ['esqueleto-vacio.pdf', 'esqueleto-vacio-2.pdf']) {
    test(`el esqueleto vacío (${muestra})`, async () => {
      const cuerpo = await readFile(join(MUESTRAS, muestra));
      const r = await validarInforme(cuerpo, { nombre: 'LUIS HERNANDO PABÓN LIZCANO' });
      assert.equal(r.valido, false, 'el esqueleto no debe pasar');
      assert.equal(r.paginas, 10);
      assert.match(r.motivo, /no contiene el nombre/i);
    });
  }

  test('un informe de otra persona: la identidad también se valida', async () => {
    const casos = await informesReales();
    if (!casos.length) return; // sin muestras locales

    const r = await validarInforme(casos[0].cuerpo, { nombre: 'PERSONA QUE NO APARECE AHI' });
    assert.equal(r.valido, false);
    assert.match(r.motivo, /no contiene el nombre/i);
  });
});

describe('validarInforme · acepta todos los informes reales', () => {
  let casos = [];
  before(async () => {
    casos = await informesReales();
  });

  test('ninguno se rechaza, incluidos los cortos', async (t) => {
    if (!casos.length) return t.skip('no hay informes en ./informes para probar');

    const rechazados = [];
    for (const caso of casos) {
      const r = await validarInforme(caso.cuerpo, { nombre: caso.nombre });
      if (!r.valido) rechazados.push(`${caso.id} (${caso.nombre}, ${r.paginas} pág): ${r.motivo}`);
    }
    assert.deepEqual(rechazados, [], `informes reales rechazados:\n  ${rechazados.join('\n  ')}`);
  });

  /**
   * La prueba que habría evitado el error. El informe más corto observado
   * bajó de 37 páginas a 23 según aparecieron evaluaciones con menos
   * evaluadores, y el umbral fijo de 20 se quedó sin margen sin que nadie lo
   * notara. Un informe corto es un informe corto, no un esqueleto.
   */
  test('un informe corto es válido: el número de páginas no decide', async (t) => {
    if (!casos.length) return t.skip('no hay informes en ./informes para probar');

    const cortos = [];
    for (const caso of casos) {
      const r = await validarInforme(caso.cuerpo, { nombre: caso.nombre });
      if (r.paginas < 30) cortos.push({ ...caso, r });
    }
    if (!cortos.length) return t.skip('no hay informes cortos entre las muestras');

    for (const corto of cortos) {
      assert.equal(corto.r.valido, true, `${corto.id} de ${corto.r.paginas} páginas debería valer`);
    }
  });
});

/**
 * El informe truncado: la tercera respuesta, la que se descubrió tarde.
 *
 * Sale cuando otra sesión de la misma cuenta le pisa el estado al servidor
 * mientras arma el PDF. Lleva el nombre del evaluado en la portada, así que
 * pasa la comprobación del texto igual que un informe entero, y lo único que
 * lo delata es que viene corto.
 *
 * El caso real: un informe llegó con 15 páginas y, repetido con una sola
 * sesión, bajó con 42.
 */
describe('validarInforme · informes cortos', () => {
  test('un informe corto se acepta pero se marca DUDOSO, nunca se rechaza', async (t) => {
    const casos = await informesReales();
    const corto = casos.find((c) => contarPaginas(c.cuerpo) < 20);
    if (!corto) {
      return t.skip('no hay ningún informe de menos de 20 páginas entre las muestras');
    }

    const r = await validarInforme(corto.cuerpo, { nombre: corto.nombre });
    assert.equal(r.valido, true, 'un informe corto NO se rechaza: se guarda y se marca');
    assert.equal(r.dudoso, true, 'pero queda marcado para que alguien lo mire');
  });

  /**
   * Blindaje contra la tentación de "arreglarlo" volviendo a rechazar por
   * número de páginas. Ya se hizo una vez, con un mínimo de 20, y tiró
   * informes buenos de 23 páginas de evaluaciones con pocos evaluadores.
   */
  test('los informes reales cortos siguen siendo válidos', async (t) => {
    const casos = await informesReales();
    const cortos = [];
    for (const caso of casos) {
      if (contarPaginas(caso.cuerpo) <= 25) cortos.push(caso);
    }
    if (!cortos.length) return t.skip('no hay informes cortos entre las muestras');

    for (const caso of cortos) {
      const r = await validarInforme(caso.cuerpo, { nombre: caso.nombre });
      assert.equal(
        r.valido,
        true,
        `${caso.id} (${contarPaginas(caso.cuerpo)} páginas) es un informe real y debe valer`
      );
    }
  });
});

describe('validarInforme · sin nombre de referencia', () => {
  test('cae en el marcador de cabecera, que el esqueleto no tiene', async () => {
    const cuerpo = await readFile(join(MUESTRAS, 'esqueleto-vacio.pdf'));
    const r = await validarInforme(cuerpo, {});
    assert.equal(r.valido, false);
  });

  test('un informe real sí pasa sin nombre', async (t) => {
    const casos = await informesReales();
    if (!casos.length) return t.skip('no hay informes en ./informes para probar');

    const r = await validarInforme(casos[0].cuerpo, {});
    assert.equal(r.valido, true);
  });
});
