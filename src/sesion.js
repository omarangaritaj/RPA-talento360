/**
 * Sesión de navegador contra talento360.
 *
 * Dos particularidades de la página condicionan todo este módulo:
 *
 * 1. Es ASP.NET WebForms con UpdatePanel. Los botones no navegan: disparan
 *    `__doPostBack`, que MsAjax convierte en un POST parcial. Por eso no sirve
 *    esperar `load`; hay que esperar a que PageRequestManager quede en reposo.
 *
 * 2. `page.evaluate(() => __doPostBack(...))` NO funciona: Playwright evalúa en
 *    strict mode y MsAjax accede a `arguments.callee`, prohibido ahí. Lanza
 *    "'caller', 'callee', and 'arguments' properties may not be accessed on
 *    strict mode functions". La única vía fiable es el click nativo.
 */
import { chromium } from 'playwright';
import { URLS, SEL, TIEMPOS, PROHIBIDOS } from './config.js';

/** Error de credenciales: no tiene sentido reintentarlo. */
export class ErrorCredenciales extends Error {}

/** Se intentó accionar un control que modifica datos. */
export class ErrorEscrituraBloqueada extends Error {}

export class Sesion {
  #browser;
  #context;

  /**
   * @param {{id:number, usuario:string, password:string}} credencial
   * @param {{headless?:boolean, slowMo?:number}} opciones
   */
  constructor(credencial, { headless = true, slowMo = 0 } = {}) {
    this.credencial = credencial;
    this.opciones = { headless, slowMo };
    this.page = null;
    /** Intentos de escritura interceptados por el guard. Debe quedar vacío. */
    this.escriturasBloqueadas = [];
  }

  get etiqueta() {
    return `worker-${this.credencial.id}`;
  }

  async abrir() {
    this.#browser = await chromium.launch({
      headless: this.opciones.headless,
      slowMo: this.opciones.slowMo,
      args: ['--disable-blink-features=AutomationControlled'],
    });
    // Contexto propio por worker: cookies y estado de sesión aislados.
    this.#context = await this.#browser.newContext({ viewport: { width: 1440, height: 900 } });
    this.page = await this.#context.newPage();
    this.page.setDefaultTimeout(TIEMPOS.timeoutAccion);
    this.page.setDefaultNavigationTimeout(TIEMPOS.timeoutNavegacion);
    await this.#instalarGuardEscritura();
    return this;
  }

  async cerrar() {
    await this.#browser?.close().catch(() => {});
  }

  /**
   * Guard de solo lectura. Intercepta los clicks en el navegador y aborta si
   * el destino es un control que crea, edita o elimina datos. `btn_Eliminar`
   * está pegado a `btnEditar` en el listado: un selector mal escrito bastaría
   * para borrar una hoja de vida.
   */
  async #instalarGuardEscritura() {
    // El preventDefault del navegador es lo que evita el daño. Esta función
    // sólo deja constancia del lado de Node: un throw aquí se convertiría en
    // una promesa rechazada dentro de la página y no detendría el proceso.
    await this.page.exposeFunction('__rpaEscrituraBloqueada', (id) => {
      this.escriturasBloqueadas.push({ id, en: new Date().toISOString() });
      console.error(`[${this.etiqueta}] GUARD: click bloqueado sobre control de escritura "${id}"`);
    });

    await this.page.addInitScript((prohibidos) => {
      document.addEventListener(
        'click',
        (evento) => {
          const objetivo = evento.target?.closest?.('[id]');
          if (objetivo && prohibidos.includes(objetivo.id)) {
            evento.preventDefault();
            evento.stopImmediatePropagation();
            window.__rpaEscrituraBloqueada?.(objetivo.id);
          }
        },
        true
      );
    }, PROHIBIDOS);
  }

  async login() {
    await this.page.goto(URLS.login, { waitUntil: 'domcontentloaded' });
    await this.page.fill(SEL.login.usuario, this.credencial.usuario);
    await this.page.fill(SEL.login.password, this.credencial.password);
    await Promise.all([
      this.page.waitForLoadState('domcontentloaded'),
      this.page.click(SEL.login.enviar),
    ]);

    // El login fallido no muestra error: simplemente vuelve a inicio.aspx.
    if (this.page.url().includes('inicio.aspx')) {
      throw new ErrorCredenciales(
        `Login rechazado para "${this.credencial.usuario}". Revisa USER_${this.credencial.id}/PASSWORD_${this.credencial.id} en .env`
      );
    }
    return this;
  }

  /** ¿La sesión sigue viva, o el servidor nos devolvió al login? */
  async sesionVigente() {
    return !this.page.url().includes('inicio.aspx');
  }

  /**
   * Espera a que MsAjax termine el postback parcial en curso.
   * Si la página no usa PageRequestManager, cae a networkidle.
   */
  async esperarPostback(timeout = TIEMPOS.esperaPostback) {
    await this.page
      .waitForFunction(
        () => {
          const prm = window.Sys?.WebForms?.PageRequestManager?.getInstance?.();
          return prm ? !prm.get_isInAsyncPostBack() : true;
        },
        null,
        { timeout }
      )
      .catch(() => {});
    await this.page.waitForLoadState('networkidle', { timeout }).catch(() => {});
    await this.page.waitForTimeout(TIEMPOS.pausaTrasPostback);
  }

  /**
   * Click seguro: valida contra la lista negra antes de tocar el DOM.
   * @param {string} selector
   */
  async clickSeguro(selector) {
    const id = selector.replace(/^#/, '');
    if (PROHIBIDOS.some((p) => id === p || id.startsWith(p))) {
      throw new ErrorEscrituraBloqueada(`Selector prohibido: ${selector}`);
    }
    await this.page.click(selector);
    await this.esperarPostback();
  }
}
