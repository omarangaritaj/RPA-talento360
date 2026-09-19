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
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { CARPETA_CUARENTENA } from './descargador.js';
import { validarInforme } from './validador.js';

const AYUDA = `
Revisión de la cuarentena de informes

  --destino <ruta>   carpeta de salida usada al descargar (por defecto ./informes)
  --detalle          lista cada archivo, no sólo el resumen
  --revalidar        vuelve a pasar cada PDF por el validador ACTUAL y reescribe
                     su diagnóstico. Úsalo después de tocar el validador: si
                     alguno pasa a válido, se recupera sin volver a pedírselo al
                     servidor, que son dos minutos por archivo
  --ayuda            esta ayuda
`;

function leerArgumentos(argv) {
  const o = { destino: 'informes', detalle: false, revalidar: false };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--destino') o.destino = argv[++i];
    else if (argv[i] === '--detalle') o.detalle = true;
    else if (argv[i] === '--revalidar') o.revalidar = true;
    else if (argv[i] === '--ayuda' || argv[i] === '-h') { console.log(AYUDA); process.exit(0); }
    else { console.error(`Opción desconocida: ${argv[i]}\n${AYUDA}`); process.exit(1); }
  }
  return o;
}

/**
 * Pasa cada PDF por el validador actual y actualiza su diagnóstico.
 *
 * La razón de existir: el motivo guardado envejece. Once páginas de error
 * quedaron archivadas como "esqueleto vacío" por un fallo del validador que se
 * corrigió después, y sin esto seguirían mintiendo para siempre en su JSON.
 *
 * Y lo que de verdad importa: si el validador mejora y alguno de los
 * rechazados pasa a válido, se recupera desde el disco. Volver a pedirlo al
 * servidor cuesta dos minutos y puede devolver otra cosa distinta.
 */
async function revalidar(carpeta, metadatos) {
  const recuperables = [];

  for (const meta of metadatos) {
    let cuerpo;
    try {
      cuerpo = await readFile(join(carpeta, `${meta.id}.pdf`));
    } catch {
      continue; // un JSON sin su PDF no se puede revalidar
    }

    const r = await validarInforme(cuerpo, { nombre: meta.nombre });
    meta.rechazadoPor = r.motivo ?? (r.valido ? 'AHORA SE CONSIDERA VÁLIDO' : 'sin motivo');
    meta.paginas = r.paginas;
    meta.revalidadoEn = new Date().toISOString();
    if (r.valido) {
      meta.ahoraValido = true;
      recuperables.push(meta);
    }

    await writeFile(join(carpeta, `${meta.id}.json`), JSON.stringify(meta, null, 2));
  }

  return recuperables;
}

/**
 * Clasifica por el MOTIVO, no por el tamaño.
 *
 * La primera versión clasificaba por número de páginas y se equivocaba de
 * lleno: llamaba "posible informe truncado" a cuatro esqueletos de 42 páginas,
 * que de truncados no tenían nada —eran la plantilla entera sin un dato
 * dentro— y metía once páginas de error de ASP.NET en el cajón de "sin
 * clasificar". El tamaño no dice qué es un archivo. El motivo sí, ahora que el
 * validador lo escribe con precisión.
 */
function clasificar(meta) {
  const motivo = meta.rechazadoPor ?? '';

  if (/no es un PDF/i.test(motivo)) return 'no era un PDF';
  if (/error de la aplicación/i.test(motivo)) return 'página de error de ASP.NET';
  if (/podría estar truncado/i.test(motivo)) return 'POSIBLE TRUNCADO — revísalo';
  if (/podría ser de OTRA persona/i.test(motivo)) return 'INFORME ARMADO DE OTRA PERSONA — revísalo';
  if (/esqueleto|título del esqueleto/i.test(motivo)) {
    // Los dos tamaños del esqueleto se separan porque significan cosas
    // distintas: el pequeño es la respuesta a una sesión sin estado; el
    // grande, la plantilla entera sin datos. Confundirlos despista.
    return meta.paginas > 20
      ? 'esqueleto GRANDE: plantilla entera sin datos'
      : 'esqueleto vacío (10 pág)';
  }
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

  const metadatos = [];
  for (const archivo of archivos) {
    try {
      metadatos.push(JSON.parse(await readFile(join(carpeta, archivo), 'utf8')));
    } catch {
      // un JSON ilegible no debe tumbar el informe entero
    }
  }

  let recuperables = [];
  if (opciones.revalidar) {
    console.log(`Revalidando ${metadatos.length} archivo(s) con el validador actual…`);
    recuperables = await revalidar(carpeta, metadatos);
  }

  const porClase = new Map();
  for (const meta of metadatos) {
    const clase = meta.ahoraValido ? 'RECUPERABLE — ahora pasa la validación' : clasificar(meta);
    if (!porClase.has(clase)) porClase.set(clase, []);
    porClase.get(clase).push(meta);
  }

  console.log(`\nCuarentena de ${carpeta} · ${archivos.length} archivo(s)\n`);

  // Lo que hay que mirar primero va primero.
  const prioridad = (c) => Number(c.includes('RECUPERABLE')) * 2 + Number(c.includes('revísalo'));
  const orden = [...porClase.keys()].sort((a, b) => prioridad(b) - prioridad(a));

  for (const clase of orden) {
    const casos = porClase.get(clase);
    console.log(`${String(casos.length).padStart(4)} · ${clase}`);

    if (opciones.detalle || clase.includes('revísalo') || clase.includes('RECUPERABLE')) {
      for (const meta of casos) {
        console.log(
          `       ${meta.id} · ${meta.nombre ?? 'sin nombre'} · ${meta.paginas ?? '?'} pág · ` +
            `${((meta.bytes ?? 0) / 1024).toFixed(0)} KB · ${((meta.ms ?? 0) / 1000).toFixed(0)}s`
        );
      }
    }
  }

  if (recuperables.length) {
    console.log(
      `\n${recuperables.length} archivo(s) pasan ahora la validación. Están en disco: ` +
        'muévelos a la carpeta de informes en vez de volver a pedirlos al servidor,\n' +
        'que son dos minutos cada uno y puede devolver otra cosa.'
    );
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
