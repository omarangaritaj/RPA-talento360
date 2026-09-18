/**
 * Persistencia de las evaluaciones de desempeño.
 *
 * Igual que `perfiles` en la etapa 1, la colección hace de checkpoint además de
 * destino: cada evaluación guarda su estado, y una corrida interrumpida se
 * reanuda preguntando qué falta. Con ~980 evaluaciones a ~20s cada una, poder
 * reanudar no es comodidad.
 *
 * Los evaluados van EMBEBIDOS y no en su propia colección. La razón es que
 * nunca se consultan sueltos: siempre se leen en el contexto de su evaluación,
 * el documento entero cabe de sobra en los 16 MB de Mongo, y así una evaluación
 * se escribe o se descarta de una sola pieza.
 */
import mongoose from 'mongoose';
import { createHash } from 'node:crypto';

export const ESTADOS_EVAL = {
  pendiente: 'pendiente',
  ok: 'ok',
  vacia: 'vacia',
  error: 'error',
};

export const ESTADOS_INFORME = {
  pendiente: 'pendiente',
  descargado: 'descargado',
  error: 'error',
  sinUrl: 'sin_url',
};

const evaluadorSchema = new mongoose.Schema(
  {
    /** autoevaluacion | jefe | par | subalterno, según el icono de la fila. */
    relacion: String,
    /** La clase del icono tal cual venía: preserva relaciones que no conozcamos. */
    iconoCrudo: String,
    nombre: String,
    cargo: String,
    /** Finalizada | Iniciada | Pendiente */
    estado: String,
    documento: String,
    matchPor: String,
    candidatos: [String],
  },
  { _id: false }
);

const informeSchema = new mongoose.Schema(
  {
    url: String,
    /**
     * Llave única del informe. `cargo` identifica el puesto y lo comparten
     * personas distintas; `id` no se repite y es lo que nombra el archivo.
     */
    id: String,
    group: String,
    cargo: String,
    estado: { type: String, enum: Object.values(ESTADOS_INFORME), default: ESTADOS_INFORME.pendiente },
    archivo: String,
    bytes: Number,
    descargadoEn: Date,
    intentos: { type: Number, default: 0 },
    ultimoError: String,
  },
  { _id: false }
);

const evaluadoSchema = new mongoose.Schema(
  {
    /**
     * Índice del botón imgBtn_Informe_Persona_N. Se renumera desde cero en cada
     * página de la grilla, así que por sí solo no identifica al evaluado: hay
     * que leerlo junto a `paginaPersonas`.
     */
    indice: Number,
    /** Página de la grilla de personas donde apareció (pagina cada 10). */
    paginaPersonas: Number,
    nombre: String,
    cargo: String,
    email: String,
    area: String,
    documento: String,
    /** email | nombre | nombre_via_evaluado | ambiguo_* | sin_match */
    matchPor: String,
    candidatos: [String],
    evaluadores: [evaluadorSchema],
    informe: informeSchema,
  },
  { _id: false }
);

const evaluacionSchema = new mongoose.Schema(
  {
    claveEvaluacion: { type: String, required: true, unique: true, index: true },
    nivel: String,
    region: String,
    grupo: String,
    fecha: String,
    medicion: String,
    estadoEval: String,
    progreso: { completadas: Number, total: Number, crudo: String },

    paginaOrigen: Number,
    indiceSelect: Number,
    /** Páginas que hubo que recorrer dentro de la grilla de personas. */
    paginasPersonas: Number,

    evaluados: [evaluadoSchema],

    estado: {
      type: String,
      enum: Object.values(ESTADOS_EVAL),
      default: ESTADOS_EVAL.pendiente,
      index: true,
    },
    intentos: { type: Number, default: 0 },
    ultimoError: String,
    motivo: String,
    extraidaEn: Date,
    duracionMs: Number,
    /** Conteo de evaluados leídos frente al total que declaraba el listado. */
    verificacion: mongoose.Schema.Types.Mixed,
  },
  { timestamps: true, collection: 'evaluaciones', strict: true, minimize: false }
);

export const Evaluacion = mongoose.model('Evaluacion', evaluacionSchema);

/**
 * Identidad de negocio de una evaluación.
 *
 * No se usa la posición en la grilla: basta con que alguien cree una evaluación
 * nueva para que todas las de abajo se corran de página y las claves dejen de
 * coincidir con lo ya guardado. Nivel, región, grupo, fecha y medición sí
 * identifican a la evaluación con independencia de dónde caiga en el listado.
 */
export function claveDeEvaluacion(fila) {
  const partes = [fila.nivel, fila.region, fila.grupo, fila.fecha, fila.medicion]
    .map((p) => (p ?? '').trim().toUpperCase())
    .join('|');
  return createHash('sha1').update(partes).digest('hex').slice(0, 16);
}

export async function sincronizarIndices() {
  await Evaluacion.syncIndexes();
}

/** Claves ya procesadas con éxito, para saltarlas al reanudar. */
export async function clavesProcesadas() {
  const hechas = await Evaluacion.find(
    { estado: { $in: [ESTADOS_EVAL.ok, ESTADOS_EVAL.vacia] } },
    { claveEvaluacion: 1, _id: 0 }
  ).lean();
  return new Set(hechas.map((e) => e.claveEvaluacion));
}

/** Guarda una evaluación extraída con éxito. Reescribe: la última lectura manda. */
export function guardarEvaluacion(clave, datos) {
  return Evaluacion.updateOne(
    { claveEvaluacion: clave },
    {
      $set: {
        ...datos,
        estado: ESTADOS_EVAL.ok,
        extraidaEn: new Date(),
        ultimoError: null,
        motivo: null,
      },
      $inc: { intentos: 1 },
    },
    { upsert: true }
  );
}

/** Registra una evaluación sin personas o con fallo. */
export function guardarFalloEvaluacion(clave, fila, { estado, mensaje, paginaOrigen }) {
  return Evaluacion.updateOne(
    { claveEvaluacion: clave },
    {
      $set: {
        ...fila,
        paginaOrigen,
        estado,
        ...(estado === ESTADOS_EVAL.error ? { ultimoError: mensaje } : { motivo: mensaje }),
      },
      $inc: { intentos: 1 },
    },
    { upsert: true }
  );
}

/**
 * Informes que todavía hay que descargar, aplanados a una lista de trabajo.
 *
 * Se devuelve `id` además de la clave de la evaluación porque es lo que
 * identifica al informe sin ambigüedad: `cargo` es el puesto y lo comparten
 * personas distintas, y el índice de fila se renumera en cada página.
 *
 * @param {{limite?:number, reintentarErrores?:boolean}} opciones
 */
export async function informesPendientes({
  limite = 0,
  reintentarErrores = false,
  incluirSinRespuestas = false,
} = {}) {
  const estados = [ESTADOS_INFORME.pendiente];
  if (reintentarErrores) estados.push(ESTADOS_INFORME.error);

  const filas = await Evaluacion.aggregate([
    { $match: { 'evaluados.informe.estado': { $in: estados } } },
    { $unwind: '$evaluados' },
    {
      $match: {
        'evaluados.informe.estado': { $in: estados },
        'evaluados.informe.url': { $nin: [null, ''] },
      },
    },
    {
      $addFields: {
        evaluadoresFinalizados: {
          $size: {
            $filter: {
              input: { $ifNull: ['$evaluados.evaluadores', []] },
              as: 'e',
              cond: { $eq: ['$$e.estado', 'Finalizada'] },
            },
          },
        },
      },
    },
    /**
     * Sin ningún evaluador que haya terminado, el servidor no tiene con qué
     * armar el informe y devuelve el esqueleto vacío de diez páginas. La
     * correlación se verificó persona a persona: de ocho informes, el único que
     * salió vacío era el único con cero evaluadores finalizados, y uno con
     * apenas 1 de 9 salió completo. Basta uno.
     *
     * Descargarlos igualmente cuesta casi tres minutos cada uno para obtener un
     * archivo que se va a descartar.
     */
    ...(incluirSinRespuestas ? [] : [{ $match: { evaluadoresFinalizados: { $gt: 0 } } }]),
    {
      $project: {
        _id: 0,
        claveEvaluacion: 1,
        medicion: 1,
        grupo: 1,
        id: '$evaluados.informe.id',
        url: '$evaluados.informe.url',
        nombre: '$evaluados.nombre',
        documento: '$evaluados.documento',
        intentos: '$evaluados.informe.intentos',
        evaluadoresFinalizados: 1,
      },
    },
    ...(limite > 0 ? [{ $limit: limite }] : []),
  ]);

  return filas;
}

/** Marca un informe como descargado. `informe.id` es único dentro de su evaluación. */
export function marcarInformeDescargado(claveEvaluacion, id, { archivo, bytes, paginas, ms }) {
  return Evaluacion.updateOne(
    { claveEvaluacion, 'evaluados.informe.id': id },
    {
      $set: {
        'evaluados.$.informe.estado': ESTADOS_INFORME.descargado,
        'evaluados.$.informe.archivo': archivo,
        'evaluados.$.informe.bytes': bytes,
        'evaluados.$.informe.paginas': paginas ?? null,
        'evaluados.$.informe.ms': ms ?? null,
        'evaluados.$.informe.descargadoEn': new Date(),
        'evaluados.$.informe.ultimoError': null,
      },
      $inc: { 'evaluados.$.informe.intentos': 1 },
    }
  );
}

/**
 * Registra un fallo de descarga sin perder el resto del documento.
 *
 * Se guardan también las páginas, el peso y el tiempo que tardó, no sólo el
 * mensaje. Cuando hubo que revisar si el filtro estaba rechazando informes
 * buenos, el número de páginas hubo que sacarlo a mano del texto del mensaje y
 * el peso y el tiempo no estaban por ninguna parte; eran las dos señales más
 * baratas y las más útiles —el esqueleto vacío llega en dos segundos, un
 * informe de verdad le cuesta minutos al servidor— y se habían tirado.
 *
 * @param {{mensaje:string, paginas?:number, bytes?:number, ms?:number, cuarentena?:string}} diagnostico
 */
export function marcarInformeError(claveEvaluacion, id, diagnostico) {
  // Durante un tiempo esta función recibía sólo el mensaje: se acepta por
  // compatibilidad para que una llamada vieja no guarde "[object Object]".
  const d = typeof diagnostico === 'string' ? { mensaje: diagnostico } : (diagnostico ?? {});

  return Evaluacion.updateOne(
    { claveEvaluacion, 'evaluados.informe.id': id },
    {
      $set: {
        'evaluados.$.informe.estado': ESTADOS_INFORME.error,
        'evaluados.$.informe.ultimoError': (d.mensaje ?? '').slice(0, 500),
        'evaluados.$.informe.paginas': d.paginas ?? null,
        'evaluados.$.informe.bytes': d.bytes ?? null,
        'evaluados.$.informe.ms': d.ms ?? null,
        'evaluados.$.informe.cuarentena': d.cuarentena ?? null,
      },
      $inc: { 'evaluados.$.informe.intentos': 1 },
    }
  );
}

/** Conteo de informes por estado, para saber cuánto falta. */
export async function resumenInformes() {
  const filas = await Evaluacion.aggregate([
    { $unwind: '$evaluados' },
    { $match: { 'evaluados.informe': { $ne: null } } },
    { $group: { _id: '$evaluados.informe.estado', total: { $sum: 1 } } },
  ]);
  return Object.fromEntries(filas.map((f) => [f._id ?? 'sin_informe', f.total]));
}

/** Conteos para el informe final. */
export async function resumenEvaluaciones() {
  const [porEstado] = await Promise.all([
    Evaluacion.aggregate([{ $group: { _id: '$estado', total: { $sum: 1 } } }]),
  ]);

  const [totales] = await Evaluacion.aggregate([
    { $unwind: { path: '$evaluados', preserveNullAndEmptyArrays: false } },
    {
      $group: {
        _id: null,
        evaluados: { $sum: 1 },
        conDocumento: { $sum: { $cond: [{ $ifNull: ['$evaluados.documento', false] }, 1, 0] } },
        conUrl: { $sum: { $cond: [{ $ifNull: ['$evaluados.informe.url', false] }, 1, 0] } },
        evaluadores: { $sum: { $size: { $ifNull: ['$evaluados.evaluadores', []] } } },
      },
    },
  ]);

  return {
    porEstado: Object.fromEntries(porEstado.map((f) => [f._id, f.total])),
    evaluados: totales?.evaluados ?? 0,
    evaluadosConCedula: totales?.conDocumento ?? 0,
    evaluadosConUrlInforme: totales?.conUrl ?? 0,
    evaluadores: totales?.evaluadores ?? 0,
  };
}
