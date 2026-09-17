# RPA talento360

Extrae información de `scouts.talento360.com.co` a MongoDB. Son dos etapas
independientes, cada una con su binario y su colección:

| Etapa | Qué extrae | Colección | Binario |
|-------|------------|-----------|---------|
| **1 · Adultos** | Hojas de vida, consolidadas con `HojaVidaSiscout.csv` | `perfiles` | `src/main.js` |
| **2 · Evaluaciones** | Evaluaciones de desempeño 360 y sus informes PDF | `evaluaciones` | `src/evaluaciones/main-eval.js` + `src/informes/main-informes.js` |

La etapa 2 se apoya en la 1: resuelve las cédulas de evaluados y evaluadores
contra `perfiles`, así que hay que correr la 1 primero.

El proceso es de **solo lectura**: no crea, edita ni elimina nada en la
aplicación de origen.

> Lo que sigue documenta la **etapa 1**. La **etapa 2** está al final, en
> [Etapa 2 · evaluaciones de desempeño](#etapa-2--evaluaciones-de-desempeño).

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

---

# Etapa 2 · evaluaciones de desempeño

Extrae las evaluaciones 360 de `GestionDeEvaluacion.aspx`: quién evalúa a quién,
con qué relación jerárquica y en qué estado, más el informe PDF de cada persona.

Va en dos fases, y son binarios separados a propósito: la fase 1 dura unas horas
y la fase 2 puede durar días. Si fueran uno solo, un fallo en la descarga
obligaría a recosechar los datos.

```bash
# Fase 1 — datos + URLs de los informes (~3-4 h)
node src/evaluaciones/main-eval.js

# Fase 2 — descarga de los PDF (reanudable, se puede cortar y seguir)
node src/informes/main-informes.js --sesiones 4
```

## Fase 1 — cosecha

| Opción | Qué hace |
|--------|----------|
| `--limite-paginas <n>` | procesa sólo n páginas (lote de prueba) |
| `--desde-pagina <n>` | empieza en esa página, para reanudar |
| `--limite-eval <n>` | procesa sólo n evaluaciones y termina |
| `--sin-informes` | no cosecha las URLs de los PDF, sólo los datos |
| `--reprocesar` | vuelve sobre evaluaciones ya guardadas |
| `--incluir-vacias` | abre también las que marcan progreso `0/0` |
| `--headed` | con ventana visible |

Es idempotente: las evaluaciones ya procesadas se saltan, así que volver a
lanzarlo continúa donde iba.

## Fase 2 — descarga de los PDF

| Opción | Qué hace |
|--------|----------|
| `--limite <n>` | descarga sólo n informes |
| `--sesiones <n>` | sesiones en paralelo (por defecto 2) |
| `--destino <ruta>` | carpeta de salida (por defecto `./informes`) |
| `--reintentar-errores` | vuelve sobre los que fallaron |

Cada informe se guarda como `<id>.pdf` junto a un `<id>.json` con el nombre, la
cédula y la evaluación. El `id` es único por persona **y** evaluación, de modo
que las N evaluaciones de una misma persona nunca se confunden.

**Sobre `--sesiones`:** el servidor genera cada PDF en el momento de pedirlo y
tarda entre dos y cuatro minutos, manteniendo tomado el lock de esa sesión. Dos
peticiones sobre la misma sesión hacen cola en vez de ir en paralelo, así que el
paralelismo se consigue con varias sesiones: cada worker hace su propio login y
recibe su propia cookie. Funciona incluso con una sola credencial. Súbelo con
cuidado y mirando los errores: es una aplicación de producción ajena.

## Estructura de la colección `evaluaciones`

```js
{
  claveEvaluacion: "a1b2c3…",              // sha1 de nivel|region|grupo|fecha|medicion
  nivel, region, grupo, fecha, medicion, estadoEval,
  progreso: { completadas: 2, total: 8, crudo: "2/8" },
  paginaOrigen: 3, paginasPersonas: 2,

  evaluados: [{
    nombre, cargo, email, area,
    documento: "52773406",
    matchPor: "email",                     // cómo se resolvió la cédula
    informe: { id, group, cargo, url, estado, archivo, bytes },
    evaluadores: [{
      relacion: "jefe",                    // autoevaluacion | jefe | par | subalterno
      nombre, cargo,
      estado: "Finalizada",                // Finalizada | Iniciada | Pendiente
      documento, matchPor
    }]
  }],

  estado: "ok",                            // pendiente | ok | vacia | error
  verificacion: { declaradosEnListado, leidosEnDetalle, coincide }
}
```

`matchPor` dice cómo se llegó a cada cédula, y es tan importante como la cédula:
permite auditar qué parte de los datos descansa sobre una coincidencia de nombre
y cuál sobre un email.

| Valor | Significado |
|-------|-------------|
| `email` | coincidencia exacta de correo con `perfiles` (la más fiable) |
| `nombre` | coincidencia de nombre normalizado, sin tildes |
| `nombre_via_evaluado` | resuelto por un evaluado que sí traía correo |
| `autoevaluacion` | es la misma persona que el evaluado |
| `ambiguo_email` / `ambiguo_nombre` | varios perfiles coinciden: queda sin resolver, con `candidatos` |
| `sin_match` | no está en `perfiles` |

## Por qué el email y no el nombre

Sobre los 2.962 perfiles de la etapa 1:

| Llave | Valores distintos | Colisiones |
|-------|-------------------|------------|
| Email | 2.960 | 2 |
| Nombre completo | 2.959 | 3 |

Las colisiones no son homónimos: son **erratas de cédula en el origen**. Los
pares detectados difieren en un dígito de más (`19434525` contra `119434525`,
`94410520` contra `944105200`), o sea la misma persona cargada dos veces. Por
eso se marcan como `ambiguo` en lugar de elegir una: la decisión es del humano.

Los evaluadores no traen correo, sólo nombre. Como una misma persona aparece
como evaluada en una evaluación y como evaluadora en otra, los evaluados ya
resueltos alimentan un índice nombre→cédula que cubre a buena parte de ellos.

## Consultar los resultados

```js
// personas cuya cédula no se pudo resolver
db.evaluaciones.aggregate([
  { $unwind: "$evaluados" },
  { $match: { "evaluados.matchPor": { $in: ["sin_match", "ambiguo_nombre", "ambiguo_email"] } } },
  { $project: { _id: 0, medicion: 1, nombre: "$evaluados.nombre", motivo: "$evaluados.matchPor" } }
])

// evaluaciones donde el conteo leído no cuadra con el que declara el listado
db.evaluaciones.find({ "verificacion.coincide": false },
                     { medicion: 1, progreso: 1, verificacion: 1, _id: 0 })

// todas las evaluaciones de una persona
db.evaluaciones.find({ "evaluados.documento": "52773406" },
                     { medicion: 1, fecha: 1, grupo: 1, _id: 0 })
```

## Notas sobre esta página

Tres comportamientos de la aplicación explican casi todo el código de espera de
`src/evaluaciones/detalle.js`. Los tres producían datos plausibles y **ningún
error**, que es la peor combinación posible.

- **El detalle se dibuja debajo del listado, en la misma página.** La tabla de
  la evaluación anterior sigue en pantalla, así que esperar a que "exista" se
  cumple al instante con los datos de quien no es. Se borra la tabla del DOM
  antes de pedir la nueva y se espera por una huella del contenido.

- **La grilla de evaluados pagina cada diez**, y el índice de página lo guarda
  el servidor: sobrevive al cambio de evaluación. Tras paginar una de catorce
  personas, la siguiente abría en su página dos y devolvía dos evaluados de
  doce. Al empezar cada evaluación se vuelve a la página uno.

- **Al paginar, la grilla pasa por estados intermedios** en los que conviven
  filas viejas y nuevas. Una lectura ahí duplica personas: una evaluación de
  catorce llegó a devolver diecinueve con sólo catorce informes distintos. Se
  exige que la huella del contenido se repita varios sondeos seguidos, y se
  deduplica por `informe.id`.

Cada evaluación guarda en `verificacion` el número de evaluados que declara la
columna "Progreso" junto al que se leyó de verdad. **Es la única red que
convierte estos fallos en un aviso visible**, y es lo primero que hay que mirar
tras una corrida.

### El informe PDF

El botón de informe no es un enlace: dispara un `__doPostBack` cuya respuesta
trae un bloque de script con

```js
window.open('../Formularios/informe_Desemp.aspx?id=1730&group=2098&cargo=381032','_blank');
```

Esos números **no están en el DOM**: los resuelve el servidor en el postback.
De los tres, `cargo` identifica el puesto y lo comparten personas distintas;
`id` es el único que identifica un informe sin ambigüedad, y es el que nombra
el archivo.

Si se deja que la pestaña navegue, el navegador pide el informe con la misma
cookie. ASP.NET serializa las peticiones de una sesión, así que durante los dos
a cuatro minutos que tarda la generación **todos los demás postbacks esperan**:
medido, tras el primer informe los cinco clicks siguientes no devolvieron nada
en 160 segundos. Interceptando `window.open` se guarda la URL sin navegar, y
cada informe pasa a costar ~330 ms. Sobre ~4.200 informes, es la diferencia
entre 187 horas y menos de media.

### Controles que nunca se pulsan

El guard compara **por patrón**, no por id exacto, porque los controles de esta
página llevan el índice de fila al final y una lista fija no los atraparía.

| Control | Riesgo |
|---------|--------|
| `imgBtn_EliminarPersonas_N` | elimina al evaluado de la evaluación |
| `imgBtn_Eliminar_Eval_N` | elimina a un evaluador |
| `imgBtn_Recordatorio_N` | **envía un correo real** al evaluador pendiente |

El de recordatorio merece atención: ocupa en la columna de acciones el mismo
lugar que el botón de borrar de los evaluadores ya finalizados, así que un click
por posición cae en uno o en otro según el estado de la fila.

## Archivos de la etapa 2

| Archivo | Qué hace |
|---------|----------|
| `src/evaluaciones/config-eval.js` | URLs, selectores, patrones prohibidos, tiempos |
| `src/evaluaciones/navegador-eval.js` | Guard por patrón e intercepción de `window.open` |
| `src/evaluaciones/listado.js` | Recorrido y paginación del listado de evaluaciones |
| `src/evaluaciones/detalle.js` | Evaluados, evaluadores y esperas de sincronización |
| `src/evaluaciones/cosecha-urls.js` | Captura de las URLs de los informes |
| `src/evaluaciones/match.js` | Resolución de cédulas contra `perfiles` |
| `src/evaluaciones/mongo-eval.js` | Esquema `evaluaciones` y checkpoint |
| `src/evaluaciones/main-eval.js` | CLI de la fase 1 |
| `src/informes/descargador.js` | Sesiones paralelas y descarga verificada |
| `src/informes/main-informes.js` | CLI de la fase 2 |
