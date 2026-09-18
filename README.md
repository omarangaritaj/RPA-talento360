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

Va en dos fases, y son binarios separados a propósito. La fase 1 deja en Mongo
todo lo que se puede leer de la pantalla; la fase 2 baja los PDF, que cuestan
casi tres minutos cada uno. Juntarlas haría que un fallo en la descarga obligara
a recosechar los datos, y los datos son la parte cara de recuperar.

**La fase 1 hay que correrla primero.** La fase 2 se apoya en lo que dejó: sin
eso no sabe a qué evaluaciones entrar ni a quién le falta el informe.

## Cómo correrlo, de principio a fin

```bash
# 0. Sólo la primera vez
npm install
npx playwright install chromium
```

**Paso 1 — probar la cosecha con una página, mirando la pantalla.**
Sirve para confirmar que el login funciona y ver qué está clickeando:

```bash
node src/evaluaciones/main-eval.js --limite-paginas 1 --headed
```

**Paso 2 — la cosecha completa.** Unas 2,2 horas medidas sobre 10 páginas de
muestra. Se puede cortar con Ctrl+C: al relanzarla sigue donde quedó.

```bash
node src/evaluaciones/main-eval.js
```

**Paso 3 — revisar que no se haya perdido nada.** Esto no es opcional: es lo
único que distingue una corrida buena de una que guardó datos plausibles pero
equivocados. Las cuatro consultas están en
[Verificar una corrida](#verificar-una-corrida); la primera, y la que nunca hay
que saltarse, es:

```js
db.evaluaciones.find({ "verificacion.coincide": false })
```

**Paso 4 — probar la descarga con una evaluación.**

```bash
node src/informes/main-informes.js --limite-eval 1
```

**Paso 5 — la descarga completa.** Unas 42 horas con 4 sesiones, pero **cada
sesión necesita su propia cuenta en `.env`** (`USER_1`…`USER_4`): dos sesiones
sobre la misma cuenta bajan informes vacíos, ver
[Sobre `--sesiones`](#sobre---sesiones-una-cuenta-por-sesión-sin-excepción).
Empieza bajo, mira la tasa de error de los primeros informes y sube sólo si va
limpio: es una aplicación de producción ajena.

```bash
node src/informes/main-informes.js --sesiones 4
```

Si se interrumpe, el mismo comando la retoma. Nada de lo descargado se repite.

## Fase 1 — cosecha

```bash
node src/evaluaciones/main-eval.js [opciones]
```

| Opción | Qué hace |
|--------|----------|
| `--limite-paginas <n>` | procesa sólo n páginas del listado (lote de prueba) |
| `--desde-pagina <n>` | empieza en esa página, para reanudar |
| `--limite-eval <n>` | procesa sólo n evaluaciones y termina |
| `--sin-informes` | no cosecha las URLs de los PDF, sólo los datos |
| `--reprocesar` | vuelve sobre evaluaciones ya guardadas |
| `--incluir-vacias` | abre también las que marcan progreso `0/0` |
| `--headed` | con ventana visible (implica `--slow-mo 150`) |
| `--headless` | sin ventana. Es el valor por defecto |
| `--slow-mo <ms>` | ralentiza cada acción, sólo para observar |
| `--ayuda` | muestra la ayuda |

Es idempotente: las evaluaciones ya procesadas se saltan, así que volver a
lanzarlo continúa donde iba. `--desde-pagina` sirve cuando se sabe dónde se
cortó y no se quiere pagar el recorrido desde la primera página.

## Fase 2 — descarga de los PDF

```bash
node src/informes/main-informes.js [opciones]
```

| Opción | Qué hace |
|--------|----------|
| `--sesiones <n>` | sesiones en paralelo. **Nunca más que cuentas haya en `.env`** |
| `--limite-eval <n>` | procesa sólo n evaluaciones |
| `--destino <ruta>` | carpeta de salida (por defecto `./informes`) |
| `--reintentar-errores` | vuelve sobre los que fallaron |
| `--incluir-sin-respuestas` | incluye a quienes no tienen ningún evaluador finalizado. Su informe sale vacío: sólo para auditar |
| `--headed` | con ventana visible |
| `--ayuda` | muestra la ayuda |

Cada informe se guarda como `<id>.pdf` junto a un `<id>.json` con el nombre, la
cédula y la evaluación. El `id` es único por persona **y** evaluación, de modo
que las N evaluaciones de una misma persona nunca se confunden.

### Sobre `--sesiones`: **una cuenta por sesión, sin excepción**

El servidor arma cada PDF en el momento de pedirlo y tarda unos 166 segundos,
manteniendo tomado el lock de esa sesión mientras tanto. Dos peticiones sobre la
misma sesión hacen cola en vez de ir en paralelo, así que el paralelismo se
consigue con varias sesiones: cada worker abre la suya, recorre el listado por
su cuenta y va reclamando las evaluaciones que nadie haya tomado.

Pero **cada sesión necesita su propia cuenta**. Aquí decía antes lo contrario
—que bastaba una credencial porque lo serializado era la sesión y no la cuenta—
y costó una corrida entera: con dos workers sobre una sola cuenta, **25 de 28
descargas devolvieron el esqueleto vacío**. Cada worker abre su propio
navegador y tiene su propia cookie, así que el aislamiento *parece* correcto y
no lo es: el estado que el servidor necesita para armar el informe —qué
evaluación está abierta y de quién se pidió el informe— vive del lado del
servidor y va atado a la cuenta.

Y el síntoma no es un error, que sería fácil de ver: es un PDF perfectamente
válido y vacío, después de dos minutos de espera. El programa ahora recorta
`--sesiones` al número de cuentas que haya en `.env` y avisa por consola.

| Cuentas en `.env` | Sesiones | Duración estimada |
|-------------------|----------|-------------------|
| 1 | 1 | ~166 h |
| 2 | 2 | ~84 h |
| 4 | 4 | ~42 h |
| 6 | 6 | ~28 h |

Súbelo con cuidado y mirando los errores. El `HTTP 500` que aparece de vez en
cuando es transitorio —sale al pedir un informe mientras el servidor sigue
ocupado con el anterior— y se reintenta solo, pero una racha de ellos significa
que hay demasiadas sesiones encima.

### Qué se considera un informe válido

Tres cosas distintas llegan con `HTTP 200` y firma `%PDF-` correcta: el informe
de verdad, un **esqueleto vacío** de 10 páginas y 109 KB, y la página de error
de ASP.NET maquetada como PDF. Se distinguen extrayendo el texto con
`pdftotext` y buscando dentro el **nombre del evaluado**: aparece en los 13 de
13 informes reales comprobados, y cero veces en el esqueleto. Valida contenido
e identidad de una vez.

> Requiere `pdftotext`, del paquete `poppler-utils`. Sin él se cae a una
> comprobación más burda y avisa por consola:
> `sudo apt install poppler-utils`

**Contar páginas no sirve para rechazar**, aunque lo parezca. Se probó con un
mínimo de 20 y tiró informes reales: el número de páginas depende de cuántos
evaluadores respondieron, y el más corto observado bajó de 37 a 23 según
aparecieron evaluaciones pequeñas. No hay umbral bueno.

#### La cuarta respuesta: el informe truncado

Hay una más, y se descubrió tarde. Cuando otra sesión de la misma cuenta le
pisa el estado al servidor mientras está armando el PDF, éste entrega **lo que
lleva hecho**. El caso que lo destapó llegó con 15 páginas; repetido con una
sola sesión, el mismo informe bajó con **42**.

Un truncado lleva el nombre del evaluado en la portada, así que pasa la
comprobación del texto igual que uno entero. Lo único que lo delata es que
viene corto — y el número de páginas ya vimos que es señal malísima para
rechazar. De ahí la asimetría, que es el punto entero:

> **El número de páginas sirve para SOSPECHAR, nunca para DESCARTAR.**

Por debajo de 20 páginas el informe se guarda igual, se marca `dudoso` en su
JSON y se canta en el log. Nadie decide por ti que ese archivo no vale; se te
avisa para que lo mires.

La causa de fondo son las sesiones compartiendo cuenta, así que con `.env` bien
puesto no deberían aparecer. Si aparecen, es la señal de que algo volvió a
pisarse.

### La cuarentena

Lo que no pasa la validación **no se tira**: va a `informes/cuarentena/` con un
JSON que dice cuántas páginas traía, cuánto pesaba, cuánto tardó el servidor y
por qué se rechazó.

No es celo de archivero. La primera versión de este filtro borraba lo que
descartaba, y cuando hubo que revisar si se estaban perdiendo informes buenos
—se estaban perdiendo— no quedaba un solo archivo que mirar. Un filtro que
decide qué datos son buenos y destruye lo que descarta no se puede auditar
jamás. Revísala de vez en cuando: es la única forma de enterarse.

Para ver qué hay dentro y por qué:

```bash
node src/informes/revisar-cuarentena.js --detalle
```

Agrupa por motivo y destaca lo que no encaja con ningún patrón conocido, que es
justo lo que hay que mirar a mano. **Si encuentras uno que el validador rechazó
mal, ese archivo es el caso de prueba que le falta** — mételo en `pruebas/` antes
de tocar el criterio.

El validador tiene su propio banco de pruebas, que corre contra archivos
guardados en vez de contra el servidor. Segundos en vez de los tres minutos que
cuesta cada intento contra la aplicación:

```bash
npm test
```

### Por qué la fase 2 vuelve a navegar

Parece que bastaría con pedir por HTTP las URLs que cosechó la fase 1. No
funciona: el servidor responde `200` y entrega un PDF válido, pero **vacío** —10
páginas, sin un dato— salvo que la sesión tenga abierto el detalle de esa
evaluación. Por eso la fase 2 recorre el listado otra vez y abre cada evaluación
antes de pedir sus informes.

Lo que sí conserva de la fase 1 es saber **a cuáles entrar y a quién le falta**,
que es lo que evita abrir las ~980 evaluaciones para bajar unos pocos informes.

### Los informes que se saltan por omisión

Sin ningún evaluador en estado `Finalizada`, el servidor no tiene con qué armar
el informe y devuelve ese mismo esqueleto de 10 páginas. La regla se verificó
persona a persona sobre una evaluación completa: de ocho informes, el único
vacío era el único con cero finalizados, y uno con apenas **1 de 9** salió
completo. Basta uno.

Son un 13% de las descargas —unas seis horas de las cuarenta y dos— para obtener
archivos que se iban a descartar, así que se saltan. `--incluir-sin-respuestas`
los recupera si hace falta auditarlos.

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
    informe: {
      id, group, cargo, url,               // `id` nombra el archivo: <id>.pdf
      estado: "descargado",                // pendiente | descargado | error | sin_url
      archivo, bytes, paginas, intentos, ultimoError
    },
    evaluadores: [{
      relacion: "jefe",                    // ver la tabla de abajo
      iconoCrudo: "fas fa-arrow-up",       // el icono tal cual, por si aparece uno nuevo
      nombre, cargo,
      estado: "Finalizada",                // Finalizada | Iniciada | Pendiente
      documento, matchPor
    }]
  }],

  estado: "ok",                            // pendiente | ok | vacia | error
  verificacion: { declaradosEnListado, leidosEnDetalle, coincide }
}
```

`relacion` sale del icono de la primera columna de la tabla de evaluadores: es la
única pista que da la aplicación, no hay texto que lo diga.

| Icono | `relacion` |
|-------|-----------|
| `fas fa-undo` | `autoevaluacion` |
| `fas fa-arrow-up` | `jefe` |
| `fas fa-arrow-right` | `par` |
| `fas fa-arrow-down` | `subalterno` |
| `fas fa-sync` | `cliente_interno` |

Se guarda además `iconoCrudo` con la clase tal cual. Parece redundante y no lo
es: `fa-sync` no estaba en la documentación de partida y apareció en 63
evaluadores que quedaban sin relación. Tener el dato crudo permitió etiquetarlos
con un `updateMany` en lugar de repetir dos horas de recorrido.

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

## Verificar una corrida

Esto es lo primero que hay que mirar al terminar, y conviene entender por qué.
Al raspar una pantalla el error que arruina el trabajo no es el que explota
—ése se ve— sino el que devuelve algo con la forma correcta y el contenido
equivocado. Durante el desarrollo aparecieron seis fallos así, y **ninguno lanzó
una excepción**: el programa informaba "0 errores" mientras guardaba
evaluaciones con los datos de otra, perdía personas al paginar o bajaba PDF sin
un dato dentro.

Por eso cada capa guarda un número que el propio RPA no calcula. Estas cuatro
consultas se pegan en el shell de Mongo, igual que las de la etapa 1:

```js
// 1. ¿Se leyeron tantos evaluados como declara la aplicación?
//    Debe salir vacío. Cada resultado es un evaluado perdido o repetido.
db.evaluaciones.find({ "verificacion.coincide": false },
  { medicion: 1, progreso: 1, verificacion: 1, _id: 0 })

// 2. ¿Cómo se resolvió cada cédula? Lo que salga como sin_match o ambiguo
//    necesita una mirada humana, no un arreglo en el código.
db.evaluaciones.aggregate([
  { $unwind: "$evaluados" },
  { $group: { _id: "$evaluados.matchPor", total: { $sum: 1 } } },
  { $sort: { total: -1 } }
])

// 3. ¿Apareció algún icono de relación que no conocemos?
//    Un null aquí es un tipo de evaluador nuevo, no un error.
db.evaluaciones.aggregate([
  { $unwind: "$evaluados" }, { $unwind: "$evaluados.evaluadores" },
  { $match: { "evaluados.evaluadores.relacion": null } },
  { $group: { _id: "$evaluados.evaluadores.iconoCrudo", total: { $sum: 1 } } }
])

// 4. Estado de las descargas
db.evaluaciones.aggregate([
  { $unwind: "$evaluados" },
  { $match: { "evaluados.informe": { $ne: null } } },
  { $group: { _id: "$evaluados.informe.estado", total: { $sum: 1 } } }
])
```

El punto 3 no es teórico: así apareció `fas fa-sync`, una quinta relación que no
estaba en la documentación de partida. Como la cosecha guarda `iconoCrudo` junto
a la relación ya traducida, etiquetarla después costó un `updateMany` en vez de
volver a recorrer la aplicación entera.

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

Y una advertencia para quien intente simplificar la fase 2: **tener la URL no
basta**. Pedirla desde una sesión limpia devuelve `200` y un PDF válido de 10
páginas sin un dato dentro; hace falta que esa sesión tenga abierto el detalle
de la evaluación. Comprobado aparte, la URL sí manda sobre de quién es el
informe —pedir el de una persona tras pulsar el botón de otra devuelve
igualmente el de la primera—, así que lo que la sesión aporta es el contexto de
la evaluación, no la identidad.

### Cómo se sabe si un PDF sirve

Tres cosas distintas llegan con `HTTP 200` y firma `%PDF-` válida: el informe de
verdad (37 a 42 páginas), el esqueleto vacío (exactamente 10) y la página de
error de ASP.NET maquetada como PDF. **Comprobar la firma no alcanza**: doce
archivos se dieron por buenos antes de detectarlo.

Se distinguen por el número de páginas, que se cuenta sobre el binario sin
librerías. Dos caminos que parecían más naturales no funcionan:

- Buscar el título dentro del PDF. El informe y el esqueleto comparten la misma
  plantilla incrustada: los dos contienen `REPORTE`, `360` y los mismos
  identificadores de control.
- Descomprimir los flujos y buscar ahí. El texto de un PDF va troceado por el
  ajuste entre caracteres —`REPORTE` puede quedar como `(R) 1 (EPORTE)`—, así
  que una búsqueda literal falla aunque el texto esté.

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
| `src/evaluaciones/mongo-eval.js` | Esquema `evaluaciones`, checkpoint y cola de informes pendientes |
| `src/evaluaciones/main-eval.js` | CLI de la fase 1 |
| `src/informes/descargador.js` | Descarga del PDF, reintentos y cuarentena |
| `src/informes/validador.js` | Decide si un PDF es el informe de esa persona |
| `src/informes/revisar-cuarentena.js` | Qué hay en la cuarentena y por qué |
| `src/informes/main-informes.js` | CLI de la fase 2: recorrido, reparto entre sesiones |
| `pruebas/validador.test.mjs` | Banco de pruebas del validador, contra archivos |
| `pruebas/descargador.test.mjs` | Que lo rechazado acabe en cuarentena y no se pierda |
| `pruebas/muestras/` | Esqueletos vacíos de referencia. Plantilla pura, sin datos de nadie |
