#!/usr/bin/env node
/**
 * Qué hay en la cuarentena y por qué.
 *
 *   node src/informes/revisar-cuarentena.js
 *   node src/informes/revisar-cuarentena.js --destino informes --detalle
 *
 * Guardar lo rechazado no sirve de nada si luego nadie lo mira. Esto agrupa lo
 * que hay por motivo y canta lo que no encaja con ninguno de los patrones
 * conocidos, que es justo lo que hay que revisar a mano.
 *
 * CÓMO LEER LO QUE SALE
 *
 *   · 10 páginas y ~109 KB, en 1-3 segundos → el esqueleto vacío. Si salen
 *     muchos, el problema no es el informe: es que hay sesiones compartiendo
 *     cuenta, o la evaluación no tiene evaluadores finalizados.
 *   · páginas intermedias tras un tiempo largo → informe TRUNCADO. El servidor
 *     empezó a armarlo y algo le pisó el estado a mitad. Vuelve a pedirlo con
 *     una sola sesión.
 *   · cualquier otra cosa → mírala de verdad, y si el validador se equivocó,
 *     ese archivo es el caso de prueba que le faltaba a `pruebas/`.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { CARPETA_CUARENTENA } from './descargador.js';

const AYUDA = `
Revisión de la cuarentena de informes

  --destino <ruta>   carpeta de salida usada al descargar (por defecto ./informes)
  --detalle          lista cada archivo, no sólo el resumen
  --ayuda            esta ayuda
`;

function leerArgumentos(argv) {
  const o = { destino: 'informes', detalle: false };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--destino') o.destino = argv[++i];
    else if (argv[i] === '--detalle') o.detalle = true;
    else if (argv[i] === '--ayuda' || argv[i] === '-h') { console.log(AYUDA); process.exit(0); }
    else { console.error(`Opción desconocida: ${argv[i]}\n${AYUDA}`); process.exit(1); }
  }
  return o;
}

/** Los tres patrones conocidos. Lo que no cae en ninguno hay que mirarlo. */
function clasificar(meta) {
  if (/no es un PDF/i.test(meta.rechazadoPor ?? '')) return 'no era un PDF';
  if (/error de la aplicación/i.test(meta.rechazadoPor ?? '')) return 'página de error de ASP.NET';
  if (meta.paginas === 10 && meta.bytes < 150 * 1024) return 'esqueleto vacío (10 pág)';
  if (meta.paginas > 10) return 'POSIBLE INFORME TRUNCADO — revísalo';
  return 'SIN CLASIFICAR — revísalo';
}

async function principal() {
  const opciones = leerArgumentos(process.argv);
  const carpeta = join(opciones.destino, CARPETA_CUARENTENA);

  let archivos = [];
  try {
    archivos = (await readdir(carpeta)).filter((a) => a.endsWith('.json'));
  } catch {
    console.log(`No hay cuarentena en ${carpeta}: nada que revisar.`);
    return;
  }

  if (!archivos.length) {
    console.log(`La cuarentena de ${carpeta} está vacía.`);
    return;
  }

  const porClase = new Map();
  for (const archivo of archivos) {
    let meta;
    try {
      meta = JSON.parse(await readFile(join(carpeta, archivo), 'utf8'));
    } catch {
      continue; // un JSON ilegible no debe tumbar el informe entero
    }
    const clase = clasificar(meta);
    if (!porClase.has(clase)) porClase.set(clase, []);
    porClase.get(clase).push(meta);
  }

  console.log(`\nCuarentena de ${carpeta} · ${archivos.length} archivo(s)\n`);

  // Lo que hay que mirar primero va primero.
  const orden = [...porClase.keys()].sort((a, b) =>
    Number(b.includes('revísalo')) - Number(a.includes('revísalo'))
  );

  for (const clase of orden) {
    const casos = porClase.get(clase);
    console.log(`${String(casos.length).padStart(4)} · ${clase}`);

    if (opciones.detalle || clase.includes('revísalo')) {
      for (const meta of casos) {
        console.log(
          `       ${meta.id} · ${meta.nombre ?? 'sin nombre'} · ${meta.paginas ?? '?'} pág · ` +
            `${((meta.bytes ?? 0) / 1024).toFixed(0)} KB · ${((meta.ms ?? 0) / 1000).toFixed(0)}s`
        );
      }
    }
  }

  const sospechosos = orden.filter((c) => c.includes('revísalo'));
  if (sospechosos.length) {
    console.log(
      '\nLos marcados para revisar son los que importan: ábrelos y comprueba si el\n' +
        'validador se equivocó. Si se equivocó, ese archivo es el caso de prueba que\n' +
        'le falta a pruebas/validador.test.mjs.'
    );
  }
  console.log('\nPara volver a pedirlos: node src/informes/main-informes.js --reintentar-errores --sesiones 1\n');
}

principal().catch((error) => {
  console.error('Fallo:', error.message);
  process.exit(1);
});
