/**
 * Persistencia en MongoDB.
 *
 * La colección hace de checkpoint además de destino: cada documento guarda su
 * propio estado de proceso, de modo que una corrida interrumpida se reanuda
 * consultando qué quedó pendiente. Con ~3.000 perfiles a varios segundos cada
 * uno, reanudar no es una comodidad: es la diferencia entre poder terminar y
 * tener que empezar de nuevo.
 */
import mongoose from 'mongoose';
import { leerMongoUri } from './config.js';

export const ESTADOS = {
  pendiente: 'pendiente',
  ok: 'ok',
  error: 'error',
  noEncontrado: 'no_encontrado',
};

/**
 * Nombres legibles para los repeaters de la página.
 * Los que no estén aquí se guardan con su nombre original: preferimos una
 * clave fea a perder una sección que no vimos durante el desarrollo.
 */
const NOMBRES_REPEATER = {
  RepeaterEducacion: 'educacion',
  RepeaterExpLaboral: 'experienciaLaboral',
  RepeaterIdioma: 'idiomas',
  Rpt_ExpScout: 'experienciaScout',
  Rpt_FormacionScout: 'formacionScout',
  RepeaterFormComp: 'formacionComplementaria',
  RepeaterFormacionComplementaria: 'formacionComplementaria',
};

const perfilSchema = new mongoose.Schema(
  {
    documento: { type: String, required: true, unique: true, index: true },
    tipoDocumento: String,

    /** Lo que venía en HojaVidaSiscout.csv, con los cargos ya agrupados. */
    csv: { type: mongoose.Schema.Types.Mixed, default: {} },

    /** Lo extraído de HojaDeVida.aspx. */
    web: { type: mongoose.Schema.Types.Mixed, default: {} },

    estado: {
      type: String,
      enum: Object.values(ESTADOS),
      default: ESTADOS.pendiente,
      index: true,
    },
    intentos: { type: Number, default: 0 },
    ultimoError: String,
    motivo: String,
    extraidoEn: Date,
    duracionMs: Number,
    /** Clics efectivos en cada "Mostrar Más": sirve para auditar la expansión. */
    expansiones: mongoose.Schema.Types.Mixed,
  },
  { timestamps: true, collection: 'perfiles', strict: true, minimize: false }
);

export const Perfil = mongoose.model('Perfil', perfilSchema);

export async function conectar() {
  await mongoose.connect(leerMongoUri(), {
    serverSelectionTimeoutMS: 30_000,
    maxPoolSize: 10,
  });
  await Perfil.syncIndexes();
  return mongoose.connection;
}

export async function desconectar() {
  await mongoose.disconnect();
}

/** Renombra los repeaters a claves legibles, conservando los desconocidos. */
export function normalizarWeb(datos) {
  if (!datos) return {};
  const { campos = {}, repeaters = {}, cargos = [], vinculosFamiliares = [], fotoUrl, secciones } = datos;

  const secciones_ = {};
  for (const [clave, items] of Object.entries(repeaters)) {
    secciones_[NOMBRES_REPEATER[clave] ?? clave] = items;
  }

  return {
    datosPersonales: campos,
    cargos,
    vinculosFamiliares,
    ...secciones_,
    fotoUrl,
    seccionesDetectadas: secciones,
  };
}

/**
 * Siembra la colección con las personas del CSV, sin pisar lo ya extraído.
 * @returns {Promise<{insertados:number, existentes:number}>}
 */
export async function sembrarDesdeCsv(personas) {
  const existentes = new Set(
    (await Perfil.find({}, { documento: 1, _id: 0 }).lean()).map((p) => p.documento)
  );

  const nuevos = personas
    .filter((p) => !existentes.has(p.documento))
    .map((p) => ({ ...p, estado: ESTADOS.pendiente, intentos: 0 }));

  if (nuevos.length) await Perfil.insertMany(nuevos, { ordered: false });
  return { insertados: nuevos.length, existentes: existentes.size };
}

/**
 * Documentos que aún hay que procesar.
 * @param {{limite?:number, reintentarErrores?:boolean}} opciones
 */
export async function pendientes({ limite = 0, reintentarErrores = false } = {}) {
  const estados = reintentarErrores
    ? [ESTADOS.pendiente, ESTADOS.error]
    : [ESTADOS.pendiente];

  const consulta = Perfil.find({ estado: { $in: estados } }, { documento: 1, _id: 0 })
    .sort({ documento: 1 })
    .lean();

  if (limite > 0) consulta.limit(limite);
  return (await consulta).map((p) => p.documento);
}

/** Guarda el resultado de un perfil extraído con éxito. */
export function guardarExito(documento, datos, { expansiones, duracionMs }) {
  return Perfil.updateOne(
    { documento },
    {
      $set: {
        web: normalizarWeb(datos),
        estado: ESTADOS.ok,
        extraidoEn: new Date(),
        duracionMs,
        expansiones,
        ultimoError: null,
        motivo: null,
      },
      $inc: { intentos: 1 },
    }
  );
}

/** Registra un fallo o una búsqueda sin resultados. */
export function guardarFallo(documento, { estado, mensaje }) {
  return Perfil.updateOne(
    { documento },
    {
      $set: {
        estado,
        ...(estado === ESTADOS.error ? { ultimoError: mensaje } : { motivo: mensaje }),
      },
      $inc: { intentos: 1 },
    }
  );
}

/** Conteo por estado, para el informe final. */
export async function resumen() {
  const filas = await Perfil.aggregate([{ $group: { _id: '$estado', total: { $sum: 1 } } }]);
  return Object.fromEntries(filas.map((f) => [f._id, f.total]));
}
