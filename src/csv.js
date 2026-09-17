/**
 * Lectura del CSV de origen.
 *
 * El archivo trae 3.688 filas pero sólo 2.971 documentos distintos: cuando una
 * persona ocupa varios cargos aparece una fila por cargo, con el resto de los
 * datos repetidos. Buscar en la web una vez por fila sería trabajo perdido —
 * el buscador devuelve un único registro por cédula.
 *
 * Por eso agrupamos por documento: los datos personales quedan en la raíz y
 * los cargos se acumulan en un arreglo. Así no se pierde información.
 */
import { readFile } from 'node:fs/promises';
import { parse } from 'csv-parse/sync';

/** El número de documento vive en la columna NÚMERO, no en TIPO DOCUMENTO. */
const COL_DOCUMENTO = 'NÚMERO';
const COL_TIPO_DOCUMENTO = 'TIPO DOCUMENTO';

/** Columnas que describen un cargo concreto y por tanto varían entre filas. */
const COLUMNAS_CARGO = ['CARGO', 'NIVEL CARGO', 'REGIÓN', 'GRUPO', 'FECHA INICIO'];

const limpiar = (valor) => (valor ?? '').trim().replace(/\s+/g, ' ') || null;

/** Normaliza el documento a dígitos: el CSV trae puntos y espacios sueltos. */
const normalizarDocumento = (valor) => (valor ?? '').replace(/[^0-9A-Za-z]/g, '').trim();

function construirCargo(fila) {
  const cargo = {
    cargo: limpiar(fila['CARGO']),
    nivelCargo: limpiar(fila['NIVEL CARGO']),
    region: limpiar(fila['REGIÓN']),
    grupo: limpiar(fila['GRUPO']),
    fechaInicio: limpiar(fila['FECHA INICIO']),
  };
  // Un cargo sin ningún dato no aporta nada.
  return Object.values(cargo).some(Boolean) ? cargo : null;
}

function construirPersona(fila, documento) {
  return {
    documento,
    tipoDocumento: limpiar(fila[COL_TIPO_DOCUMENTO]),
    csv: {
      nombre: limpiar(fila['NOMBRE']),
      fechaNacimiento: limpiar(fila['FECHA DE NACIMIENTO']),
      edad: limpiar(fila['EDAD']),
      estado: limpiar(fila['ESTADO']),
      direccion: limpiar(fila['DIRECCIÓN DE RECIDENCIA']),
      telefonos: [limpiar(fila['TELÉFONO UNO']), limpiar(fila['TELÉFONO DOS'])].filter(Boolean),
      genero: limpiar(fila['GÉNERO']),
      eps: limpiar(fila['EPS']),
      nivelEstudio: limpiar(fila['NIVEL DE ESTUDIO']),
      estadoCivil: limpiar(fila['ESTADO CIVIL']),
      tipoUsuario: limpiar(fila['TIPO DE USUARIO']),
      estudioMasReciente: limpiar(fila['ESTUDIO MAS RECIENTE']),
      perfilLaboral: limpiar(fila['PERFIL LABORAL']),
      cargos: [],
    },
  };
}

/** Dos cargos son el mismo si coinciden en todas sus columnas. */
const claveCargo = (cargo) => COLUMNAS_CARGO.map((_, i) => Object.values(cargo)[i] ?? '').join('|');

/**
 * Lee el CSV y devuelve una persona por documento único.
 * @param {string} ruta
 * @returns {Promise<Array>} personas con `csv.cargos` agrupados
 */
export async function leerPersonas(ruta) {
  const contenido = await readFile(ruta, 'utf8');
  const filas = parse(contenido, {
    columns: true,
    skip_empty_lines: true,
    bom: true,
    relax_column_count: true,
  });

  const porDocumento = new Map();
  let sinDocumento = 0;

  for (const fila of filas) {
    const documento = normalizarDocumento(fila[COL_DOCUMENTO]);
    if (!documento) {
      sinDocumento++;
      continue;
    }

    if (!porDocumento.has(documento)) {
      porDocumento.set(documento, construirPersona(fila, documento));
    }

    const persona = porDocumento.get(documento);
    const cargo = construirCargo(fila);
    if (cargo && !persona.csv.cargos.some((c) => claveCargo(c) === claveCargo(cargo))) {
      persona.csv.cargos.push(cargo);
    }
  }

  return {
    personas: [...porDocumento.values()],
    estadisticas: { filas: filas.length, unicos: porDocumento.size, sinDocumento },
  };
}
