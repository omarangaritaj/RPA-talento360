/**
 * Sesión de navegador para la etapa 2.
 *
 * Extiende la `Sesion` de la etapa 1 —login, espera de postbacks y guard de
 * escritura ya resueltos— y le añade las dos piezas propias de esta página:
 *
 *   1. Un guard POR PATRÓN. El de la etapa 1 compara ids por igualdad exacta
 *      contra una lista fija, y aquí los controles peligrosos llevan el índice
 *      de la fila al final: `..._EliminarPersonas_0`, `..._Eliminar_Eval_3`,
 *      `..._Recordatorio_5`. Una lista de ids no los atrapa jamás.
 *
 *   2. La intercepción de `window.open`, que es lo que hace viable el proyecto.
 *      Ver el comentario extenso más abajo.
 *
 * Se hereda en vez de modificar `sesion.js` a propósito: la etapa 1 ya corrió
 * y dio sus resultados, y no hay razón para arriesgar ese código.
 */
import { Sesion } from '../sesion.js';
import { PATRONES_PROHIBIDOS } from './config-eval.js';

/** Se intentó accionar un control prohibido de esta página. */
export class ErrorControlProhibido extends Error {}

export class SesionEvaluaciones extends Sesion {
  constructor(credencial, opciones) {
    super(credencial, opciones);
    /** Clicks interceptados por el guard de patrón. Debe quedar vacío. */
    this.bloqueadosPorPatron = [];
  }

  async abrir() {
    await super.abrir();
    await this.#instalarProtecciones();
    return this;
  }

  /**
   * Instala guard y captura de URLs como init script.
   *
   * Va después de `super.abrir()` y antes de cualquier navegación: los init
   * scripts se ejecutan al inicio de cada documento, y `abrir()` todavía no ha
   * navegado a ningún lado. El primer `goto` lo hace `login()`.
   */
  async #instalarProtecciones() {
    await this.page.exposeFunction('__evalBloqueado', (id) => {
      this.bloqueadosPorPatron.push({ id, en: new Date().toISOString() });
      console.error(`[${this.etiqueta}] GUARD: click bloqueado sobre "${id}"`);
    });

    // Los RegExp no cruzan la frontera a la página: viajan como fuente y se
    // reconstruyen del otro lado.
    const patrones = PATRONES_PROHIBIDOS.map((r) => r.source);

    await this.page.addInitScript((fuentes) => {
      const prohibidos = fuentes.map((f) => new RegExp(f, 'i'));

      document.addEventListener(
        'click',
        (evento) => {
          const objetivo = evento.target?.closest?.('[id]');
          if (objetivo?.id && prohibidos.some((r) => r.test(objetivo.id))) {
            evento.preventDefault();
            evento.stopImmediatePropagation();
            window.__evalBloqueado?.(objetivo.id);
          }
        },
        true
      );

      /**
       * Intercepción de window.open — la pieza que hace viable la etapa 2.
       *
       * El botón de informe dispara un postback cuya respuesta trae, en un
       * bloque de script, exactamente esto:
       *
       *   window.open('../Formularios/informe_Desemp.aspx?id=1730&group=2098&cargo=381032','_blank');
       *
       * Si se deja que esa pestaña navegue, el navegador pide el informe con la
       * MISMA cookie de sesión. ASP.NET WebForms serializa las peticiones de una
       * sesión mediante el lock exclusivo del SessionState, así que durante los
       * 2 a 4 minutos que el servidor tarda en generar el PDF, TODOS los demás
       * postbacks de esa sesión quedan esperando su turno. Medido: tras el
       * primer informe, los cinco clicks siguientes no devolvieron nada en 160s.
       *
       * Aquí la URL se guarda y no se navega a ninguna parte. Sin petición no
       * hay generación de PDF, sin generación no hay lock, y el postback
       * responde en ~330ms. Son ~4.200 informes: la diferencia entre 187 horas
       * y algo menos de media.
       *
       * El PDF se descarga después, en la fase 2, desde sesiones aparte.
       */
      window.__urlsInforme = [];
      window.open = function (url) {
        try {
          // Llegan relativas ("../Formularios/..."): se absolutizan aquí, que
          // es donde todavía se sabe contra qué documento resolverlas.
          window.__urlsInforme.push(new URL(String(url ?? ''), location.href).href);
        } catch {
          window.__urlsInforme.push(String(url ?? ''));
        }
        return null; // nada se abre
      };
    }, patrones);
  }

  /**
   * Click que valida el selector contra los patrones prohibidos ANTES de tocar
   * el DOM. El guard del navegador es la red de seguridad; esto es la puerta.
   */
  async clickEval(selector) {
    const id = selector.replace(/^#/, '');
    if (PATRONES_PROHIBIDOS.some((r) => r.test(id))) {
      throw new ErrorControlProhibido(`Selector prohibido para esta etapa: ${selector}`);
    }
    await this.page.click(selector);
  }

  /** URLs de informe capturadas desde que se cargó el documento actual. */
  urlsInforme() {
    return this.page.evaluate(() => window.__urlsInforme ?? []).catch(() => []);
  }

  /**
   * Comprueba que la intercepción está viva en el documento actual.
   * Si un postback reemplazara el `window.open` nativo, la cosecha empezaría a
   * abrir pestañas y a bloquear la sesión sin avisar: mejor detectarlo.
   */
  interceptorActivo() {
    return this.page
      .evaluate(() => Array.isArray(window.__urlsInforme) && !/native code/.test(String(window.open)))
      .catch(() => false);
  }
}
