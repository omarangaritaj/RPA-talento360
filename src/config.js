/**
 * Configuración central del RPA.
 *
 * IMPORTANTE — dotenv y la variable USER:
 * `USER` es una variable de entorno estándar de Linux (vale el login del sistema).
 * dotenv NO sobreescribe variables ya presentes en process.env, así que sin
 * `override: true` el login recibiría el usuario del sistema en vez del del .env
 * y rebotaría al formulario de login sin mensaje de error.
 */
import { config as cargarEnv } from 'dotenv';

cargarEnv({ override: true, quiet: true });

/** URLs del sistema. */
export const URLS = {
  base: 'https://scouts.talento360.com.co/hrm',
  login: 'https://scouts.talento360.com.co/hrm/inicio.aspx',
  postLogin: 'https://scouts.talento360.com.co/hrm/Default.aspx',
  adultos: 'https://scouts.talento360.com.co/hrm/Formularios/GestionHojadeVida.aspx',
  hojaVida: 'https://scouts.talento360.com.co/hrm/Formularios/HojaDeVida.aspx',
};

/** Selectores del DOM, verificados contra la página real. */
export const SEL = {
  login: {
    usuario: '#Txt_Usuario',
    // El id lleva eñe. No es un error de tipeo.
    password: '#Txt_Contraseña',
    enviar: '#Button1',
  },
  listado: {
    buscar: '#MainContent_txtBuscar',
    // Filtro por estado del registro. Arranca en "Vinculado": ver ESTADOS_LISTADO.
    estados: '#MainContent_cbo_estados',
    grid: '#MainContent_gv_GestionHojaVida',
    filaSeleccionable: '#MainContent_gv_GestionHojaVida tr[onclick]',
    editar: '#MainContent_btnEditar',
  },
  hojaVida: {
    documento: '#MainContent_txt_Documento',
    tablaFamiliares: '#MainContent_Gdv_VincFamiliares',
    tablaCargos: '#MainContent_Gdv_CargosPersonas',
  },
  /** Los cuatro "Mostrar Más". Se clickean hasta que dejan de aportar filas. */
  mostrarMas: [
    { seccion: 'educacion', selector: '#MainContent_Lkb_Mostramas' },
    { seccion: 'formacionComplementaria', selector: '#MainContent_Btn_FormComMostrarMas' },
    { seccion: 'experienciaLaboral', selector: '#MainContent_Btn_ExpLaboralMosMas' },
    { seccion: 'idiomas', selector: '#MainContent_Btn_IdiomasMosMas' },
  ],
};

/**
 * Filtro de estado del listado de hojas de vida.
 *
 * El combo `MainContent_cbo_estados` NO arranca en "Todos": el servidor lo
 * entrega preseleccionado en "Vinculado" (value 2). Buscar sin tocarlo deja
 * fuera a aspirantes, candidatos, desvinculados y bloqueados, y el RPA los
 * marcaba como "no encontrado" aunque su hoja de vida existiera.
 *
 * El combo lleva `onchange="__doPostBack(...)"`, así que cambiarlo recarga el
 * grid por postback parcial y limpia el buscador: hay que fijar el estado
 * ANTES de escribir el documento, nunca después.
 */
export const ESTADOS_LISTADO = {
  selector: '#MainContent_cbo_estados',
  /** value de la opción "Todos". El texto se usa sólo como respaldo. */
  todos: '-1',
  etiquetaTodos: 'Todos',
  /** Preselección del servidor, la que causaba los falsos "no encontrado". */
  predeterminado: '2',
};

/**
 * Lista negra de controles que MUTAN datos. El RPA es de solo lectura:
 * cualquier intento de accionar uno de estos aborta el proceso.
 * `btn_Eliminar` está inmediatamente al lado de `btnEditar` en el listado.
 */
export const PROHIBIDOS = [
  'MainContent_btn_Eliminar',
  'MainContent_btn_Nuevo',
  'MainContent_btn_usuario',
  'MainContent_ImportarDatos',
  'MainContent_hv_formacion_Btn_Guardar',
  'MainContent_formacionscout_Btn_Guardar',
  'MainContent_hv_formcomp_Btn_FormComplem',
  'MainContent_hv_explaboral_Btn_Exp_Laboral',
  'MainContent_ExperienciaScout_Btn_Exp_Laboral',
  'MainContent_idiomasperfilprofesional_Btn_Idiomas',
  'MainContent_gv_GestionHojaVida_Btn_EntrarComo',
];

/**
 * Prefijos de controles que pertenecen a los modales de ALTA.
 * Están siempre vacíos: capturarlos metería decenas de campos nulos por perfil.
 */
export const PREFIJOS_MODALES = [
  'MainContent_hv_formacion_',
  'MainContent_hv_formcomp_',
  'MainContent_hv_explaboral_',
  'MainContent_formacionscout_',
  'MainContent_ExperienciaScout_',
  'MainContent_idiomasperfilprofesional_',
];

/**
 * Controles que pertenecen a los formularios de alta embebidos en la propia
 * página (agregar cargo, agregar vínculo familiar). No llevan prefijo propio y
 * están siempre vacíos: sin excluirlos se cuelan siete campos nulos por perfil.
 */
export const CAMPOS_FORMULARIO_ALTA = [
  'MainContent_txt_Familiar',
  'MainContent_Cbo_TipVinculo',
  'MainContent_Cbo_Cargos',
  'MainContent_Cbo_Nivel',
  'MainContent_Cbo_Asesor',
  'MainContent_txt_FechInicio',
  'MainContent_Cbo_EstadoCargo',
];

/** Textos que la aplicación usa como placeholder de "sin valor". */
export const PLACEHOLDERS = [
  'Seleccione',
  'Seleccione un Cargo',
  'Seleccione-Seleccione / Seleccione-Seleccione',
  'Seleccione-Seleccione',
];

/** Tiempos. La página es lenta de forma intermitente: los timeouts son generosos. */
export const TIEMPOS = {
  timeoutNavegacion: 180_000,
  timeoutAccion: 120_000,
  esperaPostback: 12_000,
  pausaTrasPostback: 400,
  /**
   * Espera activa a que el grid del listado pinte resultados tras buscar.
   * El postback responde en ~600ms, pero una de cada diez búsquedas deja el
   * grid sin renderizar durante un instante: leer el conteo de inmediato daba
   * cero y el documento se marcaba como inexistente. Sólo se agota el tiempo
   * completo cuando el documento de verdad no está.
   */
  esperaGridResultados: 8_000,
  maxClicsMostrarMas: 40,
};

/** Rampa de concurrencia: arranca conservador y sube si todo va limpio. */
export const RAMPA = {
  escalones: [
    { workers: 1, delayMs: 2000 },
    { workers: 2, delayMs: 1500 },
    { workers: 3, delayMs: 1000 },
  ],
  exitosParaSubir: 50,
  erroresParaBajar: 3,
  maxReintentosPorPerfil: 3,
};

/**
 * Lee las credenciales del .env.
 * Formato preferido: USER_1/PASSWORD_1 … USER_N/PASSWORD_N (una por worker).
 * Compatibilidad: si no hay ninguna numerada, usa el par USER/PASSWORD.
 */
export function leerCredenciales() {
  const credenciales = [];

  for (let i = 1; i <= 10; i++) {
    const usuario = process.env[`USER_${i}`];
    const password = process.env[`PASSWORD_${i}`];
    if (usuario && password) credenciales.push({ id: i, usuario, password });
  }

  if (credenciales.length === 0 && process.env.USER && process.env.PASSWORD) {
    credenciales.push({ id: 1, usuario: process.env.USER, password: process.env.PASSWORD });
  }

  if (credenciales.length === 0) {
    throw new Error(
      'No hay credenciales en .env. Define USER_1/PASSWORD_1 (una por worker) o USER/PASSWORD. Ver .env.example'
    );
  }

  // Varios workers sobre la misma cuenta se pisan el estado de sesión en el
  // servidor: ASP.NET WebForms lo guarda allí, no en el navegador. Repetir la
  // cuenta anula el aislamiento y puede devolver la ficha de otro documento.
  const usuariosUnicos = new Set(credenciales.map((c) => c.usuario.toLowerCase()));
  if (usuariosUnicos.size < credenciales.length) {
    console.warn(
      `AVISO: hay ${credenciales.length} credenciales pero sólo ${usuariosUnicos.size} ` +
        `cuenta(s) distinta(s). Los workers que comparten cuenta comparten sesión en el ` +
        `servidor y pueden interferir entre sí. Se usará una sola por cuenta.`
    );
    const vistos = new Set();
    return credenciales.filter((c) => {
      const clave = c.usuario.toLowerCase();
      if (vistos.has(clave)) return false;
      vistos.add(clave);
      return true;
    });
  }

  return credenciales;
}

export function leerMongoUri() {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error('Falta MONGO_URI en .env');
  return uri;
}
