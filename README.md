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
node src/main.js --omitir-procesados
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
| `--reintentar-no-encontrados` | Incluye además los `no_encontrado`. Para usar tras corregir un fallo del RPA, cuando los negativos anteriores dejan de ser fiables. Manda sobre `--omitir-procesados`. |
| `--omitir-procesados` | Salta los que ya fueron consultados (`ok` o `no_encontrado`). Hace idempotente también a `--solo`. |
| `--sin-sembrar` | No relee el CSV. Útil cuando la colección ya está sembrada. |
| `--ayuda` | Muestra la ayuda. |

### Atajos de npm

| Comando | Equivale a |
|---------|-----------|
| `npm run prueba` | `node src/main.js --limite 10 --headed --workers 1` |
| `npm start` | `node src/main.js` |
| `npm run produccion` | `node src/main.js --headless` |

### Recetas

**Validar antes de una corrida larga.** Sesenta perfiles bastan para ver subir
el primer escalón de la rampa, que necesita 50 éxitos seguidos:

```bash
node src/main.js --limite 60 --headless
```

**La corrida completa.** Se puede cortar con Ctrl+C en cualquier momento: el
estado se guarda perfil a perfil, así que al relanzarla sigue donde quedó.

```bash
node src/main.js --headless
```

**Depurar un perfil concreto.** Con ventana, lento y sin releer el CSV:

```bash
node src/main.js --solo 52427771 --headed --slow-mo 400 --sin-sembrar
```

**Barrer los fallidos al día siguiente:**

```bash
node src/main.js --reintentar-errores --headless
```

**Recuperar los marcados como sin ficha tras corregir el RPA.** Un
`no_encontrado` de una corrida vieja no prueba que la persona no exista: puede
venir de un filtro mal puesto o de una espera corta. Cuando se arregla algo del
flujo de búsqueda, esos negativos hay que volver a preguntarlos:

```bash
node src/main.js --reintentar-no-encontrados --sin-sembrar --headless
```

Los que de verdad no estén cuestan ~19 s cada uno —agotan la espera del grid y
el reintento— frente a los ~10 s de un perfil normal. Es el precio de no dar
por inexistente a alguien que sí está.

**Medir el rendimiento a un ritmo fijo,** sin que la rampa cambie el escalón a
mitad de la medición:

```bash
node src/main.js --limite 100 --workers 2 --headless
```

### Cuánto tarda

Un perfil cuesta unos 10 s: búsqueda, apertura de la ficha, cuatro expansiones
y vuelta al listado. Sobre 2.971 documentos:

| Concurrencia | Duración aproximada |
|--------------|---------------------|
| 1 worker | ~10 h |
| 2 workers | ~5 h |
| 3 workers | ~3,5 h |

La rampa recorre esos escalones sola, así que una corrida completa que empieza
en 1 worker termina antes de las 10 h si el servidor lo tolera.

## Consultar los resultados

```js
// resumen por estado
db.perfiles.aggregate([{ $group: { _id: "$estado", total: { $sum: 1 } } }])

// un perfil completo
db.perfiles.findOne({ documento: "52427771" })

// los que fallaron y por qué
db.perfiles.find({ estado: "error" }, { documento: 1, ultimoError: 1, intentos: 1 })

// cédulas que no existen en la aplicación
db.perfiles.find({ estado: "no_encontrado" }, { documento: 1, motivo: 1 })

// perfiles con experiencia laboral registrada
db.perfiles.find({ "web.experienciaLaboral.0": { $exists: true } }).count()
```

## Si algo sale mal

| Síntoma | Causa y salida |
|---------|----------------|
| `Login rechazado para "..."` | Usuario o clave incorrectos en `.env`. Si el usuario que aparece es el de tu sesión de Linux, falta `USER_1` y está cayendo al `USER` del sistema. |
| `AVISO: hay N credenciales pero sólo 1 cuenta distinta` | Repetiste la misma cuenta en `USER_1..USER_N`. Se usará una sola; la rampa no pasará de un worker. |
| `Falta MONGO_URI en .env` | No hay URI de Mongo. |
| Muchos errores seguidos | La rampa baja de escalón sola. Si persisten, corta y relanza más tarde: lo hecho está guardado. |
| `sesión caída, reautenticando…` | Normal en corridas largas: el servidor caduca la sesión y el worker vuelve a entrar solo. |
| `ATENCIÓN: el guard bloqueó N intento(s) de escritura` | Un selector apuntó a un control que modifica datos. **No debería ocurrir nunca**: revísalo antes de seguir. |

## Cómo trabaja

1. Lee el CSV y agrupa las 3.688 filas en 2.971 documentos únicos. Las filas
   repetidas no son duplicados: describen cargos distintos de la misma persona,
   así que se acumulan en `csv.cargos`.
2. Siembra MongoDB con esos documentos en estado `pendiente`.
3. Por cada documento: pone el filtro de estados en **Todos**, busca la cédula,
   abre la ficha, pulsa los cuatro "Mostrar Más" hasta agotarlos y extrae las
   once secciones.
4. Guarda el resultado y marca el estado.

### Rampa de concurrencia

Arranca con un worker y pausa de 2 s. Tras 50 éxitos seguidos sube de escalón;
tras 3 errores encadenados retrocede.

| Escalón | Workers | Pausa |
|---------|---------|-------|
| 1       | 1       | 2000 ms |
| 2       | 2       | 1500 ms |
| 3       | 3       | 1000 ms |

### Reanudación e idempotencia

El estado vive en la propia colección, así que una corrida interrumpida se
retoma sola: al volver a ejecutar sólo se procesa lo que quedó `pendiente`.
Con ~3.000 perfiles a varios segundos cada uno, eso no es una comodidad.

Por eso el modo normal ya es idempotente: repetir `node src/main.js` no vuelve
a consultar nada que esté en `ok`. La excepción es `--solo`, que ignora el
estado a propósito para poder reprocesar un perfil concreto a mano. Cuando no
quieras esa excepción, añade `--omitir-procesados`:

```bash
node src/main.js --solo 52427771 --omitir-procesados   # no hace nada si ya está
node src/main.js --solo 52427771                       # lo reprocesa siempre
```

`--omitir-procesados` considera consultados los estados `ok` y `no_encontrado`
—la ficha se buscó y el resultado se conoce— pero no `error`, donde la consulta
no llegó a completarse y reintentar sí tiene sentido.

La excepción es `--reintentar-no-encontrados`: cuando se pide expresamente
volver sobre los sin ficha, `--omitir-procesados` deja de contarlos como
consultados. De lo contrario un flag anularía al otro en silencio.

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
- El listado **viene filtrado por estado "Vinculado"**. El combo
  `MainContent_cbo_estados` llega preseleccionado en el value `2`, y hay que
  ponerlo en `-1` ("Todos") antes de cada búsqueda para ver también a
  aspirantes, candidatos, desvinculados y bloqueados. Su `onchange` es un
  `__doPostBack` que repinta el grid y limpia el buscador: el orden es
  **primero el filtro, después el término de búsqueda**. Cada `goto` al
  listado devuelve el combo a su valor por defecto, así que se fija en cada
  documento.
- "Sin resultados" no tiene mensaje propio: la aplicación simplemente no
  renderiza el grid. Y el grid tarda en pintar de forma irregular —medido: una
  de cada diez búsquedas devuelve cero si se lee el conteo de inmediato—, así
  que hay que esperar de forma activa a que aparezca una fila y reintentar la
  búsqueda antes de concluir que un documento no está.
- El buscador es sensible a los espacios: un `"1053860607 "` con espacio final
  no devuelve nada.
