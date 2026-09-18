/**
 * Configuración de la etapa 2: evaluaciones de desempeño 360.
 *
 * Todo lo de aquí está verificado contra la página real, no supuesto. Donde un
 * valor tiene una razón poco evidente, la razón está escrita al lado.
 */

export const URL_EVALUACIONES =
  'https://scouts.talento360.com.co/hrm/Formularios/GestionDeEvaluacion.aspx';

/** Host del informe. Las URLs que cosechamos llegan relativas y hay que resolverlas. */
export const BASE_INFORMES = 'https://scouts.talento360.com.co/hrm/Formularios/';

export const SEL_EVAL = {
  listado: {
    grid: '#MainContent_GrdEvalDesempeno',
    /** Sólo las filas de datos: el encabezado y el paginador no llevan onclick. */
    fila: '#MainContent_GrdEvalDesempeno tr[onclick]',
    /** Carga el detalle de la evaluación seleccionada. Tarda ~15s. */
    buscar: '#MainContent_imgBtn_BuscarP',
    paginador: '#MainContent_GrdEvalDesempeno a[href*="Page$"]',
  },
  detalle: {
    personas: '#MainContent_gdv_Personas',
    /** Las filas de datos de gdv_Personas, sin el encabezado. */
    filasPersonas: '#MainContent_gdv_Personas > tbody > tr',
    informe: (i) => `#MainContent_gdv_Personas_imgBtn_Informe_Persona_${i}`,
  },
};

/**
 * Controles que MUTAN datos o disparan efectos externos.
 *
 * Van como patrones, no como ids exactos: los de esta página llevan el índice
 * de la fila al final (`..._EliminarPersonas_0`, `..._Eliminar_Eval_3`) y una
 * lista fija de ids nunca los atraparía.
 *
 * `Recordatorio` merece mención aparte: no borra nada, pero ENVÍA UN CORREO
 * REAL al evaluador pendiente. Ocupa en la columna de acciones exactamente el
 * mismo lugar que el botón de borrar de los evaluadores que ya terminaron, así
 * que un click a ciegas por posición cae en uno o en otro según la fila.
 */
export const PATRONES_PROHIBIDOS = [
  /elimin/i,
  /borrar/i,
  /delete/i,
  /remove/i,
  /guardar/i,
  /recordatorio/i,
  /_Nuevo/i,
  /Importar/i,
  /btn_config/i,
  /Add_Candidatos/i,
];

/**
 * Iconos de la primera columna de la tabla anidada de evaluadores.
 * Son la única pista del tipo de relación: no hay texto que lo diga.
 *
 * `fa-sync` no estaba en la documentación de partida; apareció al revisar los
 * evaluadores que quedaban sin relación reconocida. Se comprobó que nunca es la
 * misma persona que el evaluado —así que no es una autoevaluación—, que convive
 * con los otros cuatro iconos en la misma tabla y que sus evaluadores responden
 * como los demás.
 */
export const RELACIONES = {
  'fa-undo': 'autoevaluacion',
  'fa-arrow-up': 'jefe',
  'fa-arrow-right': 'par',
  'fa-arrow-down': 'subalterno',
  'fa-sync': 'cliente_interno',
};

/** Estados que la aplicación asigna a cada evaluador. */
export const ESTADOS_EVALUADOR = ['Finalizada', 'Iniciada', 'Pendiente'];

export const TIEMPOS_EVAL = {
  /**
   * Espera a que aparezca gdv_Personas tras pulsar "Buscar".
   * Medido en ~15s. El margen es amplio porque la página es lenta de forma
   * intermitente y reintentar cuesta mucho más que esperar de más.
   */
  esperaDetalle: 120_000,
  /**
   * Espera a que el postback del informe deje la URL en window.__urlsInforme.
   * Medido en ~330ms con la intercepción de window.open puesta. Si esto se
   * agota de forma sistemática, es señal de que la intercepción no se instaló
   * y el navegador está abriendo pestañas: ver navegador-eval.js.
   */
  esperaUrlInforme: 30_000,
  sondeoUrlInforme: 100,
  /** Pausa entre evaluaciones. No hay prisa: el cuello de botella es el servidor. */
  pausaEntreEvaluaciones: 500,
  esperaPaginacion: 30_000,
};

/** Tope de páginas a recorrer. Defensa contra un paginador que no termine nunca. */
export const MAX_PAGINAS = 500;
