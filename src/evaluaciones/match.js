/**
 * Enlace entre las personas de las evaluaciones y las cédulas de `perfiles`.
 *
 * La página de evaluaciones nunca muestra un número de documento. Lo que da es:
 *
 *   - de cada EVALUADO: nombre, cargo y EMAIL
 *   - de cada EVALUADOR: sólo nombre y cargo
 *
 * Medido sobre los 2.962 perfiles extraídos en la etapa 1:
 *
 *   email  →  2.960 valores distintos, 2 compartidos  (99,9% únicos)
 *   nombre →  2.959 valores distintos, 3 compartidos  (99,9% únicos)
 *
 * De ahí el orden: email primero, nombre después. Y una advertencia sobre esas
 * "colisiones": no son homónimos, son erratas de cédula en el origen. Los tres
 * pares detectados difieren en un dígito de más —19434525 contra 119434525,
 * 94410520 contra 944105200—, o sea la misma persona cargada dos veces. Por eso
 * se reportan como `ambiguo` en vez de elegir una: la decisión es del humano.
 *
 * Para los evaluadores hay una tercera vía. Una misma persona aparece como
 * evaluada en una evaluación y como evaluadora en otra, así que los evaluados
 * ya resueltos forman un índice nombre→cédula que resuelve a buena parte de los
 * evaluadores sin necesidad de email.
 */
import { Perfil } from '../mongo.js';

/**
 * Normaliza un nombre para compararlo.
 *
 * Quita tildes, pasa a mayúsculas y deja sólo letras y espacios. La eñe se
 * convierte en ene al descomponer, lo cual está bien mientras se aplique a los
 * dos lados de la comparación: "PABÓN" y "PABON" tienen que encontrarse.
 */
export function normalizarNombre(texto) {
  return (texto ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export const normalizarEmail = (texto) => (texto ?? '').trim().toLowerCase() || null;

/**
 * Carga los perfiles de la etapa 1 en memoria y arma los dos índices.
 *
 * Son menos de 3.000 documentos: cabe de sobra, y consultar Mongo por cada una
 * de las ~25.000 personas que hay entre evaluados y evaluadores sería absurdo.
 *
 * @returns {Promise<{porEmail:Map, porNombre:Map, total:number}>}
 */
export async function construirIndice() {
  const perfiles = await Perfil.find(
    { estado: 'ok' },
    { documento: 1, 'web.datosPersonales': 1, _id: 0 }
  ).lean();

  const porEmail = new Map();
  const porNombre = new Map();

  const agregar = (mapa, clave, documento) => {
    if (!clave) return;
    const previos = mapa.get(clave);
    if (previos) previos.push(documento);
    else mapa.set(clave, [documento]);
  };

  for (const perfil of perfiles) {
    const datos = perfil.web?.datosPersonales ?? {};
    agregar(porEmail, normalizarEmail(datos.Email), perfil.documento);

    const nombre = normalizarNombre(
      [datos.PrimerNombre, datos.SegundoNombre, datos.PrimerApellido, datos.SegundoApellido]
        .filter(Boolean)
        .join(' ')
    );
    agregar(porNombre, nombre, perfil.documento);
  }

  return { porEmail, porNombre, total: perfiles.length };
}

/**
 * Resuelve una persona a su cédula.
 *
 * `matchPor` cuenta cómo se llegó al resultado, y es tan importante como el
 * resultado mismo: permite auditar después qué parte de los datos descansa
 * sobre una coincidencia de nombre y cuál sobre un email.
 *
 * @param {{nombre?:string, email?:string}} persona
 * @param {{porEmail:Map, porNombre:Map}} indice
 * @param {Map<string,string>} [porNombreEvaluado] índice auxiliar nombre→cédula
 *   construido con los evaluados ya resueltos de esta corrida
 * @returns {{documento:string|null, matchPor:string, candidatos?:string[]}}
 */
export function resolver(persona, indice, porNombreEvaluado) {
  const email = normalizarEmail(persona.email);
  if (email) {
    const porCorreo = indice.porEmail.get(email);
    if (porCorreo?.length === 1) return { documento: porCorreo[0], matchPor: 'email' };
    if (porCorreo?.length > 1) {
      return { documento: null, matchPor: 'ambiguo_email', candidatos: porCorreo };
    }
  }

  const nombre = normalizarNombre(persona.nombre);
  if (nombre) {
    const porTexto = indice.porNombre.get(nombre);
    if (porTexto?.length === 1) return { documento: porTexto[0], matchPor: 'nombre' };
    if (porTexto?.length > 1) {
      return { documento: null, matchPor: 'ambiguo_nombre', candidatos: porTexto };
    }

    // Último recurso para los evaluadores: quizá esta persona ya apareció como
    // evaluada en otra evaluación, y allí sí traía email.
    const porEvaluado = porNombreEvaluado?.get(nombre);
    if (porEvaluado) return { documento: porEvaluado, matchPor: 'nombre_via_evaluado' };
  }

  return { documento: null, matchPor: 'sin_match' };
}

/**
 * Resuelve a todos los evaluados de una evaluación y a sus evaluadores.
 *
 * Los evaluados van primero a propósito: los que se resuelven por email
 * alimentan el índice auxiliar que después ayuda con los evaluadores, que no
 * tienen correo.
 *
 * @param {Array} evaluados salida de leerPersonas()
 * @param {{porEmail:Map, porNombre:Map}} indice
 * @param {Map<string,string>} porNombreEvaluado índice compartido de la corrida
 */
export function resolverEvaluacion(evaluados, indice, porNombreEvaluado) {
  const resueltos = evaluados.map((evaluado) => {
    const match = resolver(evaluado, indice, porNombreEvaluado);
    if (match.documento) {
      const clave = normalizarNombre(evaluado.nombre);
      if (clave && !porNombreEvaluado.has(clave)) porNombreEvaluado.set(clave, match.documento);
    }
    return { ...evaluado, documento: match.documento, matchPor: match.matchPor, candidatos: match.candidatos };
  });

  return resueltos.map((evaluado) => ({
    ...evaluado,
    evaluadores: evaluado.evaluadores.map((evaluador) => {
      // La autoevaluación es, por definición, la misma persona que el evaluado:
      // no hace falta buscarla, y resolverla por nombre sólo añadiría ruido.
      if (evaluador.relacion === 'autoevaluacion' && evaluado.documento) {
        return { ...evaluador, documento: evaluado.documento, matchPor: 'autoevaluacion' };
      }
      const match = resolver(evaluador, indice, porNombreEvaluado);
      return {
        ...evaluador,
        documento: match.documento,
        matchPor: match.matchPor,
        candidatos: match.candidatos,
      };
    }),
  }));
}

/** Resumen de calidad del match, para el informe final de la corrida. */
export function contarMatches(evaluados) {
  const conteo = {};
  const sumar = (clave) => (conteo[clave] = (conteo[clave] ?? 0) + 1);
  for (const evaluado of evaluados) {
    sumar(`evaluado:${evaluado.matchPor}`);
    for (const evaluador of evaluado.evaluadores) sumar(`evaluador:${evaluador.matchPor}`);
  }
  return conteo;
}
