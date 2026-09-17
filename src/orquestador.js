/**
 * Orquestación de la corrida completa.
 *
 * Arranca con un solo worker y una pausa amplia entre perfiles, y sólo sube de
 * escalón cuando acumula suficientes éxitos seguidos. Ante errores encadenados
 * retrocede. La idea es descubrir el ritmo que el servidor tolera en vez de
 * asumirlo: la aplicación es lenta de forma intermitente y no publica sus
 * límites.
 *
 * Cada worker usa su propia credencial. Compartirla haría que las sesiones se
 * pisaran el estado en el servidor, porque ASP.NET WebForms lo mantiene allí.
 */
import { Sesion, ErrorCredenciales } from './sesion.js';
import { procesarDocumento } from './extractor.js';
import { guardarExito, guardarFallo, ESTADOS } from './mongo.js';
import { RAMPA } from './config.js';

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

/** Consola con marca de tiempo: una corrida larga sin horas es ilegible. */
const log = (mensaje) => console.log(`[${new Date().toLocaleTimeString('es-CO')}] ${mensaje}`);

/**
 * Estado compartido de la rampa.
 * Sube tras `exitosParaSubir` aciertos seguidos y baja tras `erroresParaBajar`
 * fallos seguidos.
 */
class Rampa {
  /**
   * @param {number} maxWorkers credenciales disponibles
   * @param {number} [fijo] si se indica, la concurrencia queda clavada ahí y
   *   la rampa deja de subir y bajar. Útil para medir a un ritmo concreto.
   */
  constructor(maxWorkers, fijo) {
    this.fijo = fijo ? Math.min(fijo, maxWorkers) : null;
    this.escalon = this.fijo
      ? Math.max(0, RAMPA.escalones.findIndex((e) => e.workers >= this.fijo))
      : 0;
    this.maxEscalon = Math.min(RAMPA.escalones.length, maxWorkers) - 1;
    this.exitosSeguidos = 0;
    this.erroresSeguidos = 0;
  }

  get actual() {
    return RAMPA.escalones[this.escalon];
  }

  get workers() {
    if (this.fijo) return this.fijo;
    return Math.min(this.actual.workers, this.maxEscalon + 1);
  }

  registrarExito() {
    if (this.fijo) return false;
    this.exitosSeguidos++;
    this.erroresSeguidos = 0;
    if (this.exitosSeguidos >= RAMPA.exitosParaSubir && this.escalon < this.maxEscalon) {
      this.escalon++;
      this.exitosSeguidos = 0;
      log(`↑ subiendo a ${this.actual.workers} workers, pausa ${this.actual.delayMs}ms`);
      return true;
    }
    return false;
  }

  registrarError() {
    if (this.fijo) return false;
    this.erroresSeguidos++;
    this.exitosSeguidos = 0;
    if (this.erroresSeguidos >= RAMPA.erroresParaBajar && this.escalon > 0) {
      this.escalon--;
      this.erroresSeguidos = 0;
      log(`↓ bajando a ${this.actual.workers} workers, pausa ${this.actual.delayMs}ms`);
      return true;
    }
    return false;
  }
}

/** Cola compartida: los workers toman de aquí de a uno. */
class Cola {
  constructor(items) {
    this.items = [...items];
    this.indice = 0;
  }
  siguiente() {
    return this.indice < this.items.length ? this.items[this.indice++] : null;
  }
  get restantes() {
    return this.items.length - this.indice;
  }
  get total() {
    return this.items.length;
  }
}

/**
 * Procesa un documento reintentando ante fallos transitorios.
 * Las credenciales inválidas no se reintentan: no van a mejorar solas.
 */
async function procesarConReintentos(sesion, documento, contadores) {
  let ultimoError;

  for (let intento = 1; intento <= RAMPA.maxReintentosPorPerfil; intento++) {
    const inicio = Date.now();
    try {
      // Una sesión caducada devuelve al login sin avisar.
      if (!(await sesion.sesionVigente())) {
        log(`[${sesion.etiqueta}] sesión caída, reautenticando…`);
        await sesion.login();
      }

      const resultado = await procesarDocumento(sesion, documento);

      if (!resultado.encontrado) {
        await guardarFallo(documento, { estado: ESTADOS.noEncontrado, mensaje: resultado.motivo });
        contadores.noEncontrados++;
        return { ok: true, encontrado: false };
      }

      await guardarExito(documento, resultado.datos, {
        expansiones: resultado.expansiones,
        duracionMs: Date.now() - inicio,
      });
      contadores.ok++;
      return { ok: true, encontrado: true };
    } catch (error) {
      if (error instanceof ErrorCredenciales) throw error;
      ultimoError = error;
      log(`[${sesion.etiqueta}] ${documento} intento ${intento}/${RAMPA.maxReintentosPorPerfil}: ${error.message.slice(0, 120)}`);
      await dormir(1500 * intento); // espera creciente entre reintentos
    }
  }

  await guardarFallo(documento, { estado: ESTADOS.error, mensaje: ultimoError?.message ?? 'desconocido' });
  contadores.errores++;
  return { ok: false };
}

/**
 * Ejecuta la corrida.
 *
 * @param {string[]} documentos
 * @param {Array} credenciales una por worker
 * @param {{headless?:boolean, slowMo?:number}} opciones
 */
export async function ejecutar(documentos, credenciales, opciones = {}) {
  const cola = new Cola(documentos);
  const rampa = new Rampa(credenciales.length, opciones.workers);
  if (rampa.fijo) log(`Concurrencia fija en ${rampa.fijo} worker(s): la rampa queda desactivada.`);
  const contadores = { ok: 0, errores: 0, noEncontrados: 0 };
  const inicio = Date.now();

  if (credenciales.length < RAMPA.escalones.at(-1).workers) {
    log(
      `Aviso: hay ${credenciales.length} credencial(es) en .env, así que la rampa ` +
        `no pasará de ${credenciales.length} worker(s). Define USER_1..USER_3 para usar los tres.`
    );
  }

  /**
   * Un worker: espera su turno según el escalón, toma de la cola y procesa.
   *
   * Los workers por encima del escalón actual quedan en espera en vez de
   * terminar: si salieran definitivamente, la rampa no podría subir nunca y
   * toda la corrida se haría con un solo worker.
   *
   * El navegador se abre de forma perezosa, en la primera vuelta en la que al
   * worker le toca trabajar, para no dejar sesiones abiertas sin uso.
   */
  async function worker(credencial) {
    let sesion = null;

    try {
      while (cola.restantes > 0) {
        if (credencial.id > rampa.workers) {
          await dormir(2000); // en espera: la rampa todavía puede subir
          continue;
        }

        if (!sesion) {
          sesion = new Sesion(credencial, opciones);
          await sesion.abrir();
          await sesion.login();
          log(`[${sesion.etiqueta}] sesión iniciada como ${credencial.usuario}`);
        }

        const documento = cola.siguiente();
        if (!documento) break;

        const resultado = await procesarConReintentos(sesion, documento, contadores);
        resultado.ok ? rampa.registrarExito() : rampa.registrarError();

        const hechos = contadores.ok + contadores.errores + contadores.noEncontrados;
        if (hechos % 10 === 0) informarProgreso(hechos, cola, contadores, inicio, rampa);

        await dormir(rampa.actual.delayMs);
      }
    } finally {
      if (sesion) {
        if (sesion.escriturasBloqueadas.length) {
          log(`[${sesion.etiqueta}] ATENCIÓN: el guard bloqueó ${sesion.escriturasBloqueadas.length} intento(s) de escritura`);
        }
        await sesion.cerrar();
        log(`[${sesion.etiqueta}] finalizado`);
      }
    }
  }

  // Todos los workers disponibles arrancan; los que sobran para el escalón
  // actual se retiran solos en la primera vuelta y vuelven si la rampa sube.
  const activos = credenciales.slice(0, RAMPA.escalones.at(-1).workers);
  await Promise.all(activos.map((c) => worker(c).catch((e) => log(`[worker-${c.id}] abortado: ${e.message}`))));

  return { ...contadores, duracionMs: Date.now() - inicio, total: cola.total };
}

function informarProgreso(hechos, cola, contadores, inicio, rampa) {
  const transcurrido = (Date.now() - inicio) / 1000;
  const porSegundo = hechos / transcurrido;
  const restanSeg = porSegundo > 0 ? cola.restantes / porSegundo : 0;
  const hhmm = (s) => `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;

  log(
    `${hechos}/${cola.total} · ok ${contadores.ok} · sin ficha ${contadores.noEncontrados} · ` +
      `error ${contadores.errores} · ${porSegundo.toFixed(2)}/s · restan ~${hhmm(restanSeg)} · ` +
      `escalón ${rampa.workers}w/${rampa.actual.delayMs}ms`
  );
}
