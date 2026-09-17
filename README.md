# RPA talento360

Extrae las hojas de vida de adultos de `scouts.talento360.com.co` y las
consolida en MongoDB junto con los datos de `HojaVidaSiscout.csv`.

El proceso es de **solo lectura**: no crea, edita ni elimina nada en la
aplicación de origen.

## Requisitos

- Node 20 o superior
- Acceso a MongoDB (local o Atlas)
- Una cuenta de talento360 por worker

## Configuración

Copia `.env.example` a `.env` y completa:

```
USER_1=...        PASSWORD_1=...
USER_2=...        PASSWORD_2=...
USER_3=...        PASSWORD_3=...
MONGO_URI=mongodb+srv://...
```

Cada worker necesita **su propia cuenta**. ASP.NET WebForms guarda el estado de
sesión en el servidor, así que dos workers con la misma cuenta se pisan entre
sí. Si repites cuentas, el programa lo detecta, avisa y usa una sola por cuenta.

> `USER` es una variable de entorno propia de Linux. Por eso dotenv se carga con
> `override: true`; sin eso el login recibiría el usuario del sistema y rebotaría
> al formulario sin dar error.

## Uso

```bash
npm install
npx playwright install chromium

npm run prueba                      # 10 perfiles, con ventana y 1 worker
node src/main.js                    # corrida completa, con rampa
node src/main.js --reintentar-errores
node src/main.js --solo 52427771,94501035
node src/main.js --workers 2        # concurrencia fija, sin rampa
node src/main.js --ayuda
```

### Opciones

| Opción | Qué hace |
|--------|----------|
| `--limite <n>` | Toma sólo los primeros `n` pendientes. Para lotes de prueba. |
| `--solo <docs>` | Procesa exactamente esos documentos, separados por coma. Ignora el estado que tengan. |
| `--workers <n>` | Fija la concurrencia en `n` y desactiva la rampa. Topeado por el número de cuentas disponibles. |
| `--headed` | Abre el navegador con ventana. Implica `--slow-mo 250` si no se indica otro valor. |
| `--headless` | Sin ventana. Es el valor por defecto. |
| `--slow-mo <ms>` | Pausa entre acciones del navegador. Sólo para observar; no sustituye a la pausa entre perfiles. |
| `--reintentar-errores` | Incluye los documentos en estado `error` además de los `pendiente`. |
| `--sin-sembrar` | No relee el CSV. Útil cuando la colección ya está sembrada. |
| `--ayuda` | Muestra la ayuda. |

## Cómo trabaja

1. Lee el CSV y agrupa las 3.688 filas en 2.971 documentos únicos. Las filas
   repetidas no son duplicados: describen cargos distintos de la misma persona,
   así que se acumulan en `csv.cargos`.
2. Siembra MongoDB con esos documentos en estado `pendiente`.
3. Por cada documento: busca la cédula, abre la ficha, pulsa los cuatro
   "Mostrar Más" hasta agotarlos y extrae las once secciones.
4. Guarda el resultado y marca el estado.

### Rampa de concurrencia

Arranca con un worker y pausa de 2 s. Tras 50 éxitos seguidos sube de escalón;
tras 3 errores encadenados retrocede.

| Escalón | Workers | Pausa |
|---------|---------|-------|
| 1       | 1       | 2000 ms |
| 2       | 2       | 1500 ms |
| 3       | 3       | 1000 ms |

### Reanudación

El estado vive en la propia colección, así que una corrida interrumpida se
retoma sola: al volver a ejecutar sólo se procesa lo que quedó `pendiente`.
Con ~3.000 perfiles a varios segundos cada uno, eso no es una comodidad.

## Estructura de la colección `perfiles`

```js
{
  documento: "52427771",
  tipoDocumento: "Cédula de ciudadanía",
  csv: { nombre, fechaNacimiento, edad, estado, direccion, telefonos: [],
         genero, eps, nivelEstudio, estadoCivil, tipoUsuario,
         estudioMasReciente, perfilLaboral, cargos: [...] },
  web: { datosPersonales: {...}, cargos: [...], vinculosFamiliares: [...],
         educacion: [...], formacionComplementaria: [...], formacionScout: [...],
         experienciaLaboral: [...], experienciaScout: [...], idiomas: [...],
         fotoUrl, seccionesDetectadas: [...] },
  estado: "pendiente" | "ok" | "error" | "no_encontrado",
  intentos, ultimoError, motivo, extraidoEn, duracionMs, expansiones
}
```

`csv` y `web` se guardan por separado a propósito: las dos fuentes discrepan.
Un mismo perfil puede traer dos cargos en el CSV y cuatro en la aplicación.

## Garantía de solo lectura

`btn_Eliminar` está inmediatamente al lado de `btnEditar` en el listado, así que
hay dos barreras:

- una lista negra en Node que rechaza el selector antes de tocar el DOM;
- un `preventDefault` instalado en la página que intercepta el click y lo
  registra.

Los controles vetados están en `PROHIBIDOS` (`src/config.js`): eliminar, crear,
guardar en cualquier sección, importar y "Entrar Como".

## Archivos

| Archivo | Qué hace |
|---------|----------|
| `src/config.js` | URLs, selectores, listas de exclusión, rampa, credenciales |
| `src/csv.js` | Lectura y agrupación del CSV por documento |
| `src/sesion.js` | Navegador, login, espera de postbacks, guard de escritura |
| `src/extractor.js` | Expansión de paginación y extracción de las 11 secciones |
| `src/mongo.js` | Esquema, siembra, checkpoint y consultas de estado |
| `src/orquestador.js` | Cola, workers, rampa y reintentos |
| `src/main.js` | CLI |

## Notas sobre la aplicación de origen

- Es ASP.NET WebForms con UpdatePanel. Los botones no navegan: disparan
  `__doPostBack`, que MsAjax convierte en un POST parcial.
- `page.evaluate(() => __doPostBack(...))` **no funciona**: Playwright evalúa en
  strict mode y MsAjax accede a `arguments.callee`. Hay que usar click nativo.
- "Editar" sí navega de verdad a `HojaDeVida.aspx`, que tarda ~2,5 s en armarse
  por completo. Se espera por anclas concretas, no por tiempo fijo.
- Las listas son Repeaters con ids del tipo
  `MainContent_<Repeater>_Lbl_<Campo>_<n>`. Se detectan por patrón, no por lista
  fija, para no perder secciones que no aparecían en los perfiles de muestra.
