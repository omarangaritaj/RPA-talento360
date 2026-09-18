/**
 * Pruebas del descargador: que lo bueno se guarde donde toca y que **lo
 * rechazado no se pierda**.
 *
 *   node --test pruebas/
 *
 * La sesión se sustituye por un doble que devuelve lo que se le diga, así que
 * estas pruebas no tocan el servidor ni tardan minutos. Lo único que se
 * comprueba aquí es el comportamiento del módulo: a dónde van los archivos y
 * qué diagnóstico queda escrito.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { descargarInforme, CARPETA_CUARENTENA } from '../src/informes/descargador.js';

const MUESTRAS = join(dirname(fileURLToPath(import.meta.url)), 'muestras');

/** Sesión falsa: responde siempre con el mismo cuerpo. */
function sesionQueDevuelve(cuerpo, { status = 200 } = {}) {
  return {
    request: {
      async get() {
        return {
          ok: () => status >= 200 && status < 300,
          status: () => status,
          body: async () => cuerpo,
        };
      },
    },
  };
}

const INFORME = {
  id: '9999',
  url: 'https://ejemplo/informe_Desemp.aspx?id=9999',
  nombre: 'LUIS HERNANDO PABÓN LIZCANO',
  documento: '91472028',
  claveEvaluacion: 'eval-de-prueba',
};

describe('descargarInforme', () => {
  let destino;
  let esqueleto;

  before(async () => {
    destino = await mkdtemp(join(tmpdir(), 'informes-prueba-'));
    esqueleto = await readFile(join(MUESTRAS, 'esqueleto-vacio.pdf'));
  });

  after(async () => {
    await rm(destino, { recursive: true, force: true });
  });

  test('un PDF rechazado se guarda en cuarentena, no se tira', async () => {
    const r = await descargarInforme(sesionQueDevuelve(esqueleto), INFORME, destino);

    assert.equal(r.ok, false);
    assert.ok(r.cuarentena, 'debería devolver la ruta del archivo en cuarentena');

    const enCuarentena = await readdir(join(destino, CARPETA_CUARENTENA));
    assert.deepEqual(enCuarentena.sort(), ['9999.json', '9999.pdf']);

    // El PDF entero, byte a byte: sirve de poco un recorte.
    const guardado = await readFile(join(destino, CARPETA_CUARENTENA, '9999.pdf'));
    assert.ok(guardado.equals(esqueleto), 'el PDF debe guardarse íntegro');
  });

  test('el JSON de cuarentena lleva el diagnóstico completo', async () => {
    await descargarInforme(sesionQueDevuelve(esqueleto), INFORME, destino);

    const meta = JSON.parse(
      await readFile(join(destino, CARPETA_CUARENTENA, '9999.json'), 'utf8')
    );

    assert.equal(meta.id, '9999');
    assert.equal(meta.nombre, INFORME.nombre);
    assert.equal(meta.paginas, 10);
    assert.equal(meta.bytes, esqueleto.length);
    assert.equal(typeof meta.ms, 'number', 'el tiempo es la señal más barata: no se pierde');
    assert.match(meta.rechazadoPor, /no contiene el nombre/i);
  });

  test('una respuesta que no es PDF también acaba en cuarentena', async () => {
    const basura = Buffer.from('<html><body>Session expired</body></html>');
    const r = await descargarInforme(sesionQueDevuelve(basura), { ...INFORME, id: '8888' }, destino);

    assert.equal(r.ok, false);
    assert.match(r.motivo, /no es un PDF/i);
    const guardado = await readFile(join(destino, CARPETA_CUARENTENA, '8888.pdf'));
    assert.ok(guardado.equals(basura));
  });

  test('un HTTP 500 persistente no deja archivo: no hay cuerpo que guardar', async () => {
    const r = await descargarInforme(
      sesionQueDevuelve(Buffer.alloc(0), { status: 500 }),
      { ...INFORME, id: '7777' },
      destino,
      { intentos: 1 }
    );

    assert.equal(r.ok, false);
    assert.match(r.motivo, /HTTP 500/);
    const enCuarentena = await readdir(join(destino, CARPETA_CUARENTENA));
    assert.ok(!enCuarentena.includes('7777.pdf'));
  });
});
