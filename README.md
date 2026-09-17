# Tablero a Informe

Un único artefacto que toma los datos de **cualquier tablero de Power BI** y los
devuelve como informe en hojas A4 listas para PDF — siempre con la misma
tipografía, los mismos colores, el mismo layout y los mismos componentes.

Implementa el `Manual_PowerBI_Claude_Informes_Multiples.pdf` de este repositorio.

**Artefacto publicado:** https://claude.ai/artifact/KigZaFPEkTFwuRnSBnPrgw

```
Power BI Service → modelo semántico → Execute Queries → backend seguro
   → JSON normalizado → UN ÚNICO ARTEFACTO → Ejecutivo / Finanzas / KAM / Gerencia → PDF
```

## Cómo se autentica

Hay dos modos, y el que viene por defecto **no depende de un administrador**.

| | **Delegado** (por defecto) | **Service Principal** |
|---|---|---|
| Quién entra | Vos, con tu cuenta corporativa | Una identidad de aplicación |
| Permisos | Los mismos que ya tenés en Power BI | Los que le den a la app |
| Tenant setting de IT | **No hace falta** | *Allow service principals…*, sólo un admin |
| Que te agreguen al workspace | **No hace falta**: ya tenés acceso | Un admin debe agregar la app |
| Modelos con RLS o SSO | **Funciona** (sos vos) | No funciona |
| Secreto en `.env` | **Ninguno** | `CLIENT_SECRET` |
| Corre solo, sin nadie | No: hay que entrar cada tanto | Sí |

El modo se elige solo: si hay `CLIENT_SECRET` en `.env` usa Service Principal;
si no, delegado. `AUTH_MODO=delegado` lo fuerza.

En modo delegado el backend usa el **flujo de código de dispositivo**: muestra un
código de 8 caracteres, lo escribís en `microsoft.com/devicelogin` con tu cuenta
de siempre, y listo.

**Una sesión por persona, no una por servidor.** Cada navegador recibe una cookie
con un identificador al azar y su token se guarda contra ese identificador, así
que varios compañeros pueden usar el mismo backend y cada uno consulta Power BI
con **sus** permisos — que es lo que hace que el RLS del modelo siga aplicándose.
Los tokens van a `backend/.sesiones.json`, ignorado por git y escrito con
permisos `0600`; sobreviven a un reinicio y se descartan a los 30 días sin uso.

Si en cambio cada persona levanta su propio backend, funciona igual: el
`CLIENT_ID` no es secreto y se puede compartir.

**Lo único que necesitás:** el `CLIENT_ID` y el `TENANT_ID` de una app
registrada en Microsoft Entra como **cliente público** (sin secreto). En la mayoría de las
organizaciones, registrar una app no requiere administrador: el ajuste *Users
can register applications* viene habilitado por defecto en Entra.

### Registrar la app en Entra (una vez, ~3 minutos)

En [entra.microsoft.com](https://entra.microsoft.com). Los nombres van como
aparecen con el portal en español; entre paréntesis, en inglés.

| Paso | Dónde | Qué hacer |
|---|---|---|
| 1 | **Identidad** (*Identity*) → **Aplicaciones** (*Applications*) → **Registros de aplicaciones** (*App registrations*) | Clic en **+ Nuevo registro** (*New registration*) |
| 2 | Formulario | **Nombre**: `Informes Power BI`. En **Tipos de cuenta admitidos** (*Supported account types*) dejá la **primera** opción. Dejá vacío **URI de redirección**. **Registrar** (*Register*) |
| 3 | **Información general** (*Overview*) | Copiá **los dos**, uno debajo del otro: **Id. de aplicación (cliente)** (*Application (client) ID*) y **Id. de directorio (inquilino)** (*Directory (tenant) ID*) |
| 4 | Menú de la app → **Autenticación** (*Authentication*) | Bajá hasta **Configuración avanzada** (*Advanced settings*) → **Permitir flujos de cliente público** (*Allow public client flows*) → poné **Sí** → **Guardar** |

El paso 4 es el que habilita el flujo de código de dispositivo; sin eso el
ingreso falla con `invalid_client`.

**Sobre el paso 2:** «inquilino único» no quiere decir «sólo vos». Quiere decir
*todas las cuentas de tu organización*, así que tus compañeros entran con la
misma app sin tocar nada. La opción multiinquilino habilitaría a gente de otras
empresas, que no es lo que querés.

No hace falta crear ningún secreto, ni tocar **Permisos de API** (*API
permissions*): los permisos delegados de Power BI se piden en el momento del
ingreso y los aprobás vos mismo en la pantalla de Microsoft.

Si el botón **Nuevo registro** aparece deshabilitado, tu organización desactivó
el registro de aplicaciones y ahí sí hay que pedirle a IT — pero es un pedido
chico: *registrar una app como cliente público, sólo lectura sobre Power BI*.
No el ajuste de Service Principals a nivel de toda la empresa.

La app de este proyecto ya está registrada y sus dos identificadores viven en
**`backend/entra.json`**, versionado. No hay que configurar nada: `npm run dev`
y a entrar con tu cuenta.

```jsonc
{ "clientId": "…", "tenantId": "…" }
```

### Por qué esos dos pueden estar en el repositorio

`clientId` y `tenantId` **no son secretos**. Viajan en la URL de cualquier login
de Microsoft y van dentro del binario de cualquier app de escritorio o celular:
así está diseñado el flujo de *cliente público*. El `tenantId`, además, lo
devuelve un endpoint abierto de Microsoft a partir del dominio de mail.

Lo que nunca va acá ni a ningún archivo versionado es **`CLIENT_SECRET`**, y el
modo delegado no usa ninguno: cada persona entra con su cuenta y la API la ve
con **sus** permisos, RLS incluido.

> **Si este repositorio es público**, publicar el `clientId` facilita una
> estafa concreta: el *device code phishing*. Alguien inicia un ingreso con tu
> `clientId` y le manda el código a un empleado; si lo pega, quien estafa
> obtiene un token **como esa persona**, y la pantalla de Microsoft muestra el
> nombre de tu app, que la víctima reconoce. No es una fuga de credenciales
> —nadie entra con el `clientId` solo— pero sí una superficie que conviene no
> regalar. Dos formas de cerrarla, en orden de esfuerzo:
> 1. Poner el repositorio en **privado** (*Settings → General → Danger Zone →
>    Change visibility*). Es un clic y no cambia nada más.
> 2. Pedirle a IT una directiva de **Acceso condicional** que bloquee el flujo
>    de código de dispositivo salvo para quien lo necesite.
>
> Si preferís no versionarlos, borrá `backend/entra.json` y usá
> `npm run configurar` o los secretos de Codespaces: el orden de precedencia
> los toma igual.

### El orden de precedencia

Gana lo primero que aparezca, igual que hace dotenv:

1. Variables de entorno (secretos de Codespaces, `export`, etc.)
2. `backend/.env` (lo escribe `npm run configurar`)
3. `backend/entra.json` (versionado)

Los **dos** hacen falta. Con una app de inquilino único no se puede usar el
comodín `organizations`: Microsoft responde `AADSTS50059` porque no sabe contra
qué organización autenticar.

### `backend/.env` no sobrevive a un Codespace nuevo

Desde que la app vive en `entra.json` esto ya no bloquea a nadie, pero sigue
valiendo si apuntás a otro tenant: `.env` está fuera del repositorio a
propósito (manual, paso 20) y vive sólo en el disco de tu máquina o de tu
Codespace. Si el contenedor se recrea, el archivo se va con él y **no hay nada
que restaurar desde git**.

Rehacerlo cuesta un comando:

```bash
npm run configurar                                    # te pregunta los dos
npm run configurar -- <CLIENT_ID> <TENANT_ID>         # o se los pasás
```

Conserva lo que ya tuvieras puesto (`PORT`, `ORIGENES_PERMITIDOS`), descomenta
la línea si había quedado con `#`, y nunca toca `CLIENT_SECRET`.

Para que no se pierda nunca más, guardá los dos IDs como **secretos de
Codespaces** del repositorio:

> GitHub → tu repo → **Settings** → **Secrets and variables** → **Codespaces**
> → *New repository secret*, uno para `CLIENT_ID` y otro para `TENANT_ID`.

Se inyectan como variables de entorno en cada Codespace nuevo, y el backend las
lee aunque `backend/.env` no exista. Nada de esto entra al repositorio.

`CLIENT_ID` y `TENANT_ID` no son secretos —son identificadores públicos, viajan
en la URL de cualquier login de Microsoft—, así que guardarlos ahí no relaja
nada. El único valor sensible es `CLIENT_SECRET`, que el modo delegado no usa.

## La idea en una línea

El formato vive en el código del artefacto; los datos de Power BI sólo rellenan
componentes. **Cambiar de tablero cambia los números, nunca el diseño.**

## Qué hay acá

| Ruta | Qué es |
|---|---|
| `artefacto/informes-powerbi.html` | El artefacto. Un solo archivo, sin dependencias. |
| `backend/server.js` | El intermediario con Power BI. Acá viven las credenciales. |
| `backend/powerbi/` | `auth.js` (token de Entra), `client.js` (Execute Queries + REST), `descubrir.js` (workspaces, modelos, medidas), `queries.js` (armado de DAX). |
| `backend/modelo.js` | El mapeo entre los campos de los informes y los nombres de tu modelo. |
| `backend/informes/` | Un archivo por informe: sus consultas DAX y cómo se arma su JSON. |
| `backend/prueba-api.js` | La primera prueba: token + workspace + dataset + un `EVALUATE` mínimo. |
| `backend/configurar.js` | Rehace `backend/.env` sin abrir un editor. |
| `backend/entra.json` | La app de Entra del proyecto: dos identificadores públicos, versionados. |

## Cómo se usa

### Sin backend, ahora mismo

Abrí el artefacto, elegí un tipo de informe y tocá **Datos de ejemplo** para ver
el formato, o **Pegar JSON** para renderizar la respuesta real de tu backend.
Después, **Exportar PDF**.

> Publicado en claude.ai el navegador bloquea las llamadas de la página a otros
> servidores, así que el botón **Actualizar datos** no puede llegar a tu backend
> desde ahí. Serví el artefacto desde tu propio backend y funciona solo.

### Con backend

Desde la raíz del repositorio:

```bash
npm install     # instala backend/ (workspace)
npm run dev     # o npm start, sin recarga
```

La app de Entra ya viene en `backend/entra.json`, así que no hay paso de
configuración. Para apuntar a otro tenant: `npm run configurar`.

### En Codespaces, «localhost:3000» no es la dirección

El servidor corre en la nube, no en tu máquina, así que `localhost:3000` no
lleva a ningún lado. La dirección es la del **puerto reenviado**, y el arranque
ahora la imprime:

```
Artefacto:  https://<tu-codespace>-3000.app.github.dev/
            ↑ ésa es la dirección, no localhost
```

Si no se abre solo: pestaña **PUERTOS** (abajo, al lado de TERMINAL) → fila
del 3000 → el ícono del **globo** («Abrir en el navegador»).

El repositorio trae `.devcontainer/devcontainer.json` para que eso pase solo:
reenvía el 3000, lo abre en vista previa al levantarse y corre `npm install` al
crear el Codespace. Aplica a los Codespaces **nuevos** o cuando reconstruyas el
actual (*Codespaces: Rebuild Container*); en el que ya tenés abierto, andá por
la pestaña PUERTOS.

Después abrí `localhost:3000` → **Conectar a Power BI** → **Entrar con mi cuenta**.

Después abrí `http://localhost:3000/`: el artefacto queda servido desde el mismo
origen que la API, así que **Actualizar datos** consulta Power BI de verdad.
En Codespaces, abrí el puerto 3000 reenviado y ya caés en el artefacto.

Sin `.env` el servidor arranca igual y sirve el artefacto: podés trabajar con
**Datos de ejemplo** y **Pegar JSON**. Sólo *Actualizar datos* necesita
credenciales.

| Comando | Qué hace |
|---|---|
| `npm run configurar` | Escribe `backend/.env` con tu `CLIENT_ID` y `TENANT_ID`. |
| `npm run dev` | Levanta el backend con recarga al guardar. |
| `npm start` | Igual, sin recarga. |
| `npm run prueba` | Token + workspace + dataset + un `EVALUATE` mínimo (modo Service Principal). |

`prueba` toma los IDs de `backend/modelo.json` o del `.env`, y acepta otros por
argumento sin tocar nada:

```bash
npm run prueba                                          # el tablero configurado
npm run prueba -- <workspaceId> <datasetId>             # otro tablero
npm run prueba -- <ws> <ds> 'EVALUATE ROW("R", [Real])' # otra consulta
```

### Vincular con tu modelo semántico

Con el backend levantado, **Conectar a Power BI** hace todo el vínculo sin tocar
código. Tiene tres pestañas:

1. **Tablero** — pegá la URL del tablero abierto en Power BI y listo: se leen
   los IDs que traiga y, si trae el reporte pero no el modelo (que es el caso
   normal), el backend le pregunta a la API cuál lo alimenta. También podés
   elegir a mano de las listas, que salen de `GET /groups` y
   `GET /groups/{ws}/datasets` y muestran qué reportes usa cada modelo.

   | URL que pegues | Qué se resuelve |
   |---|---|
   | `/groups/{ws}/modeling/{ds}/modelView` | workspace + modelo |
   | `/groups/{ws}/settings/datasets/{ds}` | workspace + modelo |
   | `/groups/{ws}/reports/{rep}/...` | workspace + **modelo, resuelto por API** |
   | `/groups/{ws}/lineage` | sólo el workspace |
   | `/groups/me/...` | Mi área de trabajo no tiene GUID: la API no la alcanza |
2. **Mapeo del modelo** — **Detectar automáticamente** deduce el mapeo solo:
   prueba nombres habituales en español e inglés contra tu modelo y completa
   el formulario con lo que encuentra, incluido el formato del período.
   **Verificar contra el modelo** prueba cada referencia con un `EVALUATE`
   mínimo y marca si existe, una por una. Lo que quede vacío, el informe lo
   saltea. **Empezar de cero** borra el mapeo guardado y vuelve a la semilla
   del repositorio, sin abrir una terminal.

   Como `executeQueries` no admite funciones `INFO` ni DMV, no hay forma de
   pedirle al modelo que se liste. Lo que sí se puede es probar:
   `EVALUATE TOPN(1, Tabla)` acierta o falla, y cuando acierta devuelve todas
   las columnas de esa tabla de una sola vez; con las medidas pasa lo mismo
   con `EVALUATE ROW("v", [Medida])`. El recorrido entero cabe en el
   presupuesto de 120 consultas por minuto de la API, y si Power BI corta por
   frecuencia lo avisa en vez de dar por ausente algo que sí está.
3. **Consola DAX** — ejecuta cualquier consulta de lectura contra el modelo. Es
   la forma de descubrir como se llaman tus medidas antes de mapearlas.

El mapeo en uso vive en `backend/modelo.json`, que **no** va al repositorio:
si lo versionáramos, cada vez que guardaras el mapeo se bloquearía el próximo
`git pull`. Lo que sí va versionado es la semilla, `backend/modelo.ejemplo.json`,
y el archivo en uso se crea a partir de ella la primera vez.

La semilla ya viene con el mapeo completo del tablero de Deuda de este
proyecto: 14 medidas y 9 columnas, verificadas contra el modelo. Para empezar
de cero con otro tablero está el botón **Empezar de cero** en *Conectar →
Mapeo del modelo* (o `POST /api/modelo/reiniciar`), que borra
`backend/modelo.json` y vuelve a sembrarlo.

### Un campo que no existe se señala solo

Escribir una referencia que el modelo no tiene es el error más fácil de
cometer, y Power BI lo reporta de la peor manera posible: *«The value for 'BO'
cannot be determined»*, sin decir de dónde salió ese `BO`. El backend traduce
ese mensaje a la casilla del mapeo que lo produjo y la devuelve en el campo
`campo` de la respuesta; el artefacto la nombra, y **Corregir ⟨campo⟩** abre
*Mapeo* con el cursor puesto ahí.

Además la anota en `rotos`, dentro de `modelo.json`. Desde ese momento:

- `GET /api/informes` da por ausente ese campo, así que el selector deja de
  ofrecer los informes que dependen de él (marcados *— no está en tu modelo*)
  en vez de dejarte llegar al mismo error;
- el informe que la usaba de forma opcional la saltea, y sale sin esa sección;
- la casilla aparece en rojo, con la marca *✗ no existe*, apenas abrís *Mapeo*.

La anotación se borra sola: al reescribir esa casilla, al verificar con éxito,
o con **Empezar de cero**. Sólo se marca lo que el modelo contestó que no
conoce — un timeout o un 401 no ensucian el mapeo — y verificar sin haber
elegido workspace y modelo devuelve un 400 en vez de dar todo por roto.

> **Descubrimiento de medidas.** El boton *Traer medidas del modelo* intenta
> `INFO.VIEW.MEASURES()`, pero el endpoint clasico `executeQueries` **no admite
> funciones INFO** (si el nuevo Execute DAX Queries, que responde en Arrow). Si
> tu modelo las rechaza, el artefacto te lo dice y seguis por la consola DAX.

Tambien podes sacar los IDs a mano de la URL del reporte en Power BI Service:
`.../groups/{workspaceId}/reports/{reportId}/...`. El **Dataset ID** esta en el
elemento *Modelo semantico* asociado al reporte, en el mismo workspace.

### Que campos entiende el mapeo

| Grupo | Campos |
|---|---|
| Medidas | `real`*, `bo`*, `variacion`, `variacionPct`, `ebitda`, `margenEbitda`, `opex`, `opexBo`, `provisiones`, `pendienteFacturar`, `dso`, `saldoCxC`, `facturacion`, `costos`, `margen`, `margenPct`, `clientesActivos` |
| Columnas | `periodo`*, `sociedad`, `vertical`, `gastoCategoria`, `agingTramo`, `clienteNombre`, `clienteKam` |

Una medida no tiene por qué ser una medida del modelo: donde el dato es una
columna, vale una **agregación** — `SUM(Tabla[Columna])`, `MIN(...)`, `MAX(...)`,
`AVERAGE(...)`, `COUNT(...)`, `DISTINCTCOUNT(...)`. La lista de funciones es
cerrada; cualquier otra cosa se rechaza antes de tocar una consulta.

Si el DSO vive en su propia tabla sin relación con el calendario —como suele
pasar—, mapeá además **Período de la tabla de DSO** y el informe toma el valor
del último período, igual que la card del tablero.

El único obligatorio es el **período**: es lo que ordena cualquier serie. Qué
medidas hacen falta lo decide **cada informe**, no el mapeo — un modelo de
cobranzas no tiene Real ni BO, y no tiene por qué inventarlos.

`GET /api/informes` devuelve, además del catálogo, si el mapeo actual alcanza
para cada informe y qué le falta. El selector del artefacto marca los que no
salen, se mueve solo al primero que sí, y avisa antes de consultar en vez de
dejar que Power BI responda un error sobre una medida inexistente. `periodo` debe ser una columna con el
**entero AAAAMM** (202607): DAX no agrupa por expresiones, asi que una columna
de fecha no sirve para las series de evolucion. Si no la tenes, agrega al modelo
una columna calculada `YEAR([Fecha])*100 + MONTH([Fecha])`.

`variacion` se toma del modelo si existe; si no, el backend usa `real - bo`. Es
la unica cuenta que hace, y solo porque una resta no es logica de negocio que
pueda diferir del tablero.

### Rutas del backend

| Ruta | Para que |
|---|---|
| `GET /api/auth` | Modo, si hay sesión y con qué cuenta. |
| `POST /api/auth/ingresar` | Arranca el código de dispositivo. |
| `POST /api/auth/salir` | Borra la sesión guardada. |
| `GET /api/powerbi/workspaces` | Workspaces visibles. |
| `GET /api/powerbi/workspaces/:ws/modelos` | Modelos semanticos y sus reportes. |
| `GET /api/powerbi/workspaces/:ws/reportes/:id` | De un reporte al modelo que lo alimenta. |
| `POST /api/powerbi/detectar` | Deduce el mapeo probando nombres habituales. |
| `GET /api/powerbi/modelos/:ws/:ds/medidas` | Medidas via INFO, si el modelo las admite. |
| `POST /api/powerbi/dax` | Consola DAX de solo lectura. |
| `GET` / `PUT /api/modelo` | Leer y guardar el mapeo. |
| `POST /api/modelo/verificar` | Probar cada referencia contra el modelo. |
| `POST /api/modelo/reiniciar` | Borrar el mapeo local y volver a la semilla. |
| `GET /api/tablero/:ws/:ds/contexto` | Qué dimensiones ya vienen filtradas y cuáles se pueden elegir. |
| `GET /api/informes` | Qué informes puede dar el mapeo actual, y qué les falta. |
| `POST /api/informe` | El informe ya normalizado. |

## Empezar es tres pasos

El panel pide lo justo: **conectarse a Power BI**, elegir **área de trabajo** y
elegir **tablero**. Con una sola área, se elige sola. De ahí sale todo lo demás
—qué informe corresponde, qué segmentadores tiene, los GUID— sin que nadie los
escriba. Lo técnico (backend, IDs, mapeo, consola DAX) vive en **Avanzado**,
plegado, y casi nunca hace falta abrirlo.

No hay datos de ejemplo: el artefacto muestra el tablero real o nada.

## Dos vistas del mismo informe

Un informe puede devolver, además de las hojas A4, un **tablero interactivo**.
Hoy lo hace sólo *Deuda*; los demás siguen dando sólo hojas y nada cambia para
ellos. Las dos vistas salen de la **misma consulta**, así que el PDF es
exactamente lo que estabas mirando y no una segunda lectura que puede diferir.

| | Tablero | Informe |
|---|---|---|
| Para qué | trabajar: buscar un cliente, ordenar, filtrar | mandar, firmar, archivar |
| Montos | la cifra exacta (`$ 413.359.095`) | en millones, que es lo que hace legible una serie |
| Se imprime | no | sí — **Exportar PDF** sale de acá siempre, estés donde estés |

El impreso se acota al **top 8** de clientes en sus tablas y aperturas —es lo
que se lee en una hoja— con los totales de la cartera completa y una nota que
lo dice. El tablero tiene la tabla entera, con buscador.

El tablero de Deuda tiene seis solapas: **Resumen** (tarjetas + los dos aging),
**Cobranza** (tabla por cliente con buscador, orden y filtro de vencido, más la
apertura por clase de documento, tipo de deuda, estado y gestor), **Facturación**
(pendiente por cliente con sus principales conceptos, y apertura por concepto,
tipo y estado), **Cliente 360°** (exposición combinada), **Días en calle**
(serie mensual y promedio por año) y **Notas y alcance**, que se escribe desde
lo que *este* modelo dice — nombra tus medidas, no un texto fijo.

### Un segmentador que funciona a medias es peor que ninguno

Éste es el problema menos evidente del proyecto, y el que más silenciosamente
da números mal.

El modelo de Deuda tiene **dos tablas de hechos** —`Aging - Actualizado` para
la cobranza y `Provision` para lo pendiente de facturar— y las dos cuelgan de
`Clientes_y_Contratos` con relaciones **unidireccionales**. Además,
`[Deuda Facturacion] = CALCULATE(SUM(...), Provision)` ignora los filtros
puestos sobre su propia tabla. De ahí sale esta asimetría:

| Segmentador puesto sobre… | filtra Cobranza | filtra Facturación |
|---|---|---|
| `Clientes_y_Contratos[…]` | ✅ | ✅ |
| `'Aging - Actualizado'[…]` | ✅ | ❌ |

Un control sobre la tabla equivocada filtra la mitad de los números **y no
avisa**: el informe igual sale y parece bien. Por eso el backend no confía en
que la columna exista — la **prueba**. `GET /api/tablero/:ws/:ds/contexto` abre
cada candidato por sus valores pidiendo las medidas del informe, y mira si de
verdad las reparte o si devuelve el total entero en cada rebanada.

Lo que hace con el resultado no es descartar, es **rotular**. Un segmentador
que mueve la cobranza y no la facturación sigue siendo útil; el pecado era
mostrarlo como si filtrara todo. Así que se dibuja con la aclaración al lado
—*Gestor · sólo cobranza*— y sólo se descarta el que no mueve nada. El arranque
lo deja dicho:

```
[contexto] clienteKam se ofrece acotado: mueve deudaCobranza pero no deudaFacturacion
[contexto] moneda no se ofrece: no mueve ninguna medida ('Aging - Actualizado'[Moneda de Documento])
```

El criterio es «la medida se mueve», no «las partes suman el total»: lo segundo
suena más exigente pero se rompe solo con el `TOPN`, con los blancos y con
cualquier medida no aditiva.

Cuando una dimensión tiene **un solo valor**, no hay nada que elegir ni que
probar: pasa a ser un chip de contexto.

### Cada universo con sus propios filtros

Por lo mismo, las consultas de cobranza y las de facturación van separadas, y
las tarjetas se arman de las dos. Agruparlas juntas por una columna del aging
producía el producto cruzado —cada cliente mostrando las razones sociales de
todos los demás— porque `SUMMARIZECOLUMNS` conserva toda fila con alguna medida
no vacía, y la facturación nunca venía vacía.

### Las exclusiones del tablero se replican

Un tablero de producción casi nunca mira el modelo entero. El de Deuda declara
en pantalla sus **Exclusiones aplicadas**, y el informe las repite: sin eso los
totales no coinciden con Power BI y nadie puede explicar la diferencia.

Viven en `exclusiones`, dentro del mapeo, y se aplican **siempre** — no son
segmentadores, nadie las cambia desde el panel:

```jsonc
"exclusiones": [
  { "campo": "canal", "contiene": "32 Corporaciones" },
  { "campo": "claseDocumento", "incluir": ["AB","DB","DG","DR","DT","DX","DZ","SA"] },
  { "tipo": "ordenDePago", "campo": "claseDocumento",
    "texto": "textoCabecera", "marca": "OP", "claseConMarca": "AB" },
  { "campo": "clienteNumero", "excluir": ["4000659845"] },
  { "campos": ["documentoId", "documentoId2"], "excluir": ["6860001611"] }
]
```

Las formas simples son `igual`, `contiene`, `incluir` y `excluir`. El canal va
por `contiene` a propósito: el rótulo exacto baila entre «Petroleras» y
«Petróleo» según dónde se lea, y una tilde no debe vaciar el informe. `campos`
excluye si el valor aparece en **cualquiera** de varias columnas, para cuando
un id puede estar en dos lados.

`ordenDePago` es la única con nombre propio, porque no es un filtro suelto sino
una condición con dos ramas: la clase `AB` sólo cuenta si tiene la marca `OP`
en el texto de cabecera, y **las demás clases sólo si no la tienen**. Escrito
como dos filtros independientes dejaría fuera todo. Tiene nombre y parámetros
en vez de aceptar DAX, para que un archivo de configuración no pueda inyectar
una consulta.

Todos los valores pasan por `lit()`, así que nada entra crudo en el DAX.

El panel las lista en **Exclusiones aplicadas**, igual que Power BI, y quedan
como primera nota de alcance del informe.

### «A vencer» entra o no, y se nota

Lo que todavía no venció suma al saldo pero no es deuda en gestión. El
interruptor **Incluir «a vencer»** lo saca de **todas** las consultas de
cobranza —totales, aging, cortes y tabla por cliente— igual que destildarlo en
el tablero, que además le saca la columna al aging. La facturación no se mueve:
la provisión no tiene ese tramo.

Los rótulos no están escritos a mano. Se reconocen sobre los valores que
devolvió *tu* aging, porque cada modelo los escribe distinto («A Vencer», «No
vencido», «Por vencer»).

### La apertura por mes, y sólo si se pide

En la solapa **Facturación**, el `+` de cada fila abre en qué mes cayó ese
pendiente: los años cerrados enteros y el año en curso mes por mes, como el
tablero. Sale de `Provision[Año Provi]` y `[Mes Provi]`.

Se abre a pedido y no siempre, porque la mayoría de los clientes tienen uno o
dos meses con saldo: mostrarlo desplegado llenaría la tabla de ceros y taparía
lo que importa, que es el puñado con arrastre de años anteriores.

### Las observaciones de gestión

La hoja **Observaciones Pendiente Facturar** llega de un Excel en SharePoint y
**no tiene relación con el modelo**: es una isla. Así que se trae entera y se
une por nombre de cliente ya normalizado —sin tildes ni puntuación— porque la
planilla lo escribe a mano y alterna «VISTA OIL» con «Vista OIL».

La fecha de gestión viene dentro del texto, al final y a veces entre
paréntesis: se extrae y se muestra como marca aparte, que es lo que hace útil
la columna. Un texto largo se recorta a dos renglones con **Ver completo**.

### El color del aging es el dato

Los tramos de vencimiento no usan la paleta categórica sino una rampa de
severidad, verde a rojo, igual que el tablero: en la tabla por cliente eso da
una barra apilada donde de un vistazo se ve si el saldo es corriente o viejo.
Es la única serie del proyecto que usa colores de estado, y se justifica porque
la severidad es justamente lo que ordena los tramos.

### Saldo sin cliente

Las cobranzas sin número de contrato no se pueden atar a un cliente, porque ese
número es la clave de la relación. Tienen su propio saldo, a veces negativo. Se listan como «(En blanco)» al final de la tabla, no se descartan: si no, la suma de la tabla no cierra con el total y la diferencia no
tiene explicación. El tablero los muestra igual, como una fila en blanco.

### El tablero decide el informe

Elegir el modelo semántico es todo el trámite: el backend ya sabe qué informes
soporta ese modelo (`GET /api/informes`), así que se arma el que corresponde y
se genera. El selector de tipo aparece sólo si hay más de uno posible, detrás
de un *cambiar*.

### Lo que Power Query ya filtró no se vuelve a pedir

`executeQueries` no deja leer los pasos de Power Query, pero sí mirar el dato:
si una dimensión tiene **un solo valor distinto**, el recorte ya está hecho en
el origen. `GET /api/tablero/:ws/:ds/contexto` prueba sociedad, canal, negocio
y moneda, y clasifica cada una:

- **un valor** → contexto. Aparece como chip (`Canal: 32 Corporaciones Petróleo`),
  en la portada del PDF y como primera nota de alcance. No se ofrece como filtro.
- **varios** → filtro. El panel dibuja una lista con los valores reales, no un
  campo de texto: escribir `IHSA SA` en vez de `IHSA S.A.` devolvía un informe
  vacío sin decir por qué.

El valor por defecto se busca con tolerancia: «IHSA S.A.» encuentra «IHSA SA»,
y «32 Corporaciones» encuentra «32 Corporaciones Petróleo». Una tilde de más no
debe dejar el informe sin recortar.

### «Ver datos» abre, no repite

Cada barra del informe ya lleva su número al lado, así que desplegar los mismos
valores no agregaba nada. Ahora el botón muestra la **apertura** que hay detrás:
el aging de cobranza se abre por clase de documento, tipo de deuda, estado de
vencimiento y gestor; el de facturación por concepto, tipo y estado; los cortes
por negocio y la concentración, por cliente. Cuando el modelo no tiene esas
columnas mapeadas, queda la tabla gemela de siempre.

Las columnas que habilitan esto son opcionales y se mapean como cualquier otra
(*Conectar → Mapeo*): clase de documento, tipo de deuda, condición de pago,
estado de vencimiento, moneda, concepto, tipo, estado de facturación, tramo de
antigüedad de facturación y razón social. **Detectar automáticamente** las
busca solas.

## El contrato de datos

Todo pasa por acá. El backend devuelve esto y el artefacto lo dibuja; nada más.
El botón **Contrato y DAX** del artefacto muestra el ejemplo completo y las
consultas DAX de cada informe, listas para copiar.

```jsonc
{
  "meta": {
    "organizacion": "Grupo IHSA",
    "informe": "ejecutivo",
    "periodo": "2026-07",
    "filtros": { "sociedad": "IHSA", "vertical": "Todas" },
    "unidad": "millones de $",
    "escala": 1000000,
    "fuente": "Power BI — Real vs BO",
    "actualizado": "2026-07-31T18:05:00Z"
  },
  "secciones": [ /* ... */ ]
}
```

### Secciones que entiende el artefacto

| `tipo` | Qué dibuja | Campos |
|---|---|---|
| `kpis` | Franja de indicadores | `items[]`: `etiqueta`, `valor`, `formato`, `delta`, `sentido`, `serie[]`, `titular` |
| `resumen` / `narrativa` | Texto y viñetas | `parrafos[]`, `puntos[]` — se admite `**negrita**` |
| `comentario` | Bloque firmado | `parrafos[]`, `autor` |
| `barras` | Columnas agrupadas (Real vs BO) | `ejeX[]`, `series[{nombre,datos[]}]` |
| `lineas` | Evolución | `ejeX[]`, `series[]` |
| `barrasApiladas` | Tramos (aging) | `ejeX[]`, `series[]`, `rampa:"ordinal"` |
| `barrasHorizontales` | Ranking | `items[{etiqueta,valor}]` |
| `desvios` | Desvíos con signo | `items[{concepto,real,bo,desvio,desvioPct,favorable}]` |
| `tabla` | Tabla con totales | `columnas[{clave,titulo,tipo,firmado,colorear}]`, `filas[]`, `total` |
| `saltoPagina` | Fuerza una hoja nueva | — |

`formato`: `moneda` · `monto` · `pesos` · `pct` · `pp` · `dias` · `veces` ·
`entero` · `decimal` · `texto`.

### Informes incluidos

| Informe | Para qué modelo | Medidas que pide |
|---|---|---|
| Ejecutivo · Gerencia | P&L contra presupuesto | `real`, `bo` |
| Finanzas | P&L + OPEX, aging y DSO | `real`, `opex`, `saldoCxC`, `dso` |
| KAM | Cartera por cliente | `facturacion`, `margen` |
| **Deuda** | Cobranzas y aging de cartera | `deudaTotal`, `deudaCobranza` |

El informe de **Deuda** trata la cartera como una **foto**, no como un
acumulado mensual: los totales y el aging no se filtran por período, porque
hacerlo recortaría a las facturas que vencen en ese mes, que es otra cosa. El
corte lo dan la sociedad, el negocio y el canal.

Las tablas largas se cortan solas por filas y siguen en la hoja siguiente con el
encabezado repetido.

## Agregar un informe nuevo

No se crea otro artefacto. Se agrega un archivo en `backend/informes/` con
`{ meta, consultas, construir, requiere }` y se lo registra en
`informes/index.js`; **el selector del artefacto se sincroniza con
`GET /api/informes`**, así que aparece sin tocar el frontend. `gerencia.js` es el ejemplo más corto:
reutiliza las secciones del ejecutivo y sólo cambia el encabezado y los KPIs.

## Decisiones de diseño

- **Tipografías:** Archivo (títulos), IBM Plex Sans (texto), IBM Plex Mono
  (cifras, con `tabular-nums` donde los números se alinean en columna).
- **Acento:** teal `#0B6870`, el de la casa. Los colores de estado
  (favorable/desfavorable) nunca se usan como color de serie, y nunca deciden
  solos: van siempre con ▲/▼ y la palabra.
- **Series de gráfico:** orden fijo `#00909B → #C75300 → #6B3FA0 → #B0116B`
  (claro) y `#1E9AA6 → #C96422 → #8C72CF → #CC4A8D` (oscuro), validados para
  daltonismo y contra el fondo de cada tema. Los tramos de aging usan una rampa
  ordinal de un solo tono. Nunca hay dos ejes Y en un gráfico.
- **Hojas A4 reales** en pantalla: lo que se ve es lo que sale en el PDF, con
  cabecera, fuente, fecha/hora de actualización y número de página en cada hoja.
- Los datos de ejemplo van marcados como tales **también en el PDF**, para que
  un informe de prueba no se confunda con uno real.

## Seguridad

- En modo delegado **no hay secreto**: el cliente es público y el refresh token
  queda en `backend/.sesion.json`, ignorado por git y con permisos `0600`.
- El `CLIENT_SECRET` (sólo modo Service Principal) vive en `backend/.env`, que
  está en `.gitignore`.
- El artefacto guarda en el navegador únicamente la URL del backend y los IDs
  del tablero. Nunca un token ni un secreto.
- El backend valida que `workspaceId` y `datasetId` sean GUID, y escapa todo
  valor de filtro antes de interpolarlo en DAX.
- `ORIGENES_PERMITIDOS` es una lista explicita: nunca `*`.
- El mapeo solo acepta referencias con la forma exacta `[Medida]` o
  `Tabla[Columna]`; cualquier otra cosa se rechaza antes de tocar una consulta.
- La consola DAX es de solo lectura, pero deja leer todo el modelo: se apaga
  sola con `NODE_ENV=production`, y se fuerza con `CONSOLA_DAX=1` o `=0`.
- Service Principal **no es compatible** con datasets con RLS ni con SSO
  habilitado. Verificalo antes de construir (manual, paso 4).

## Referencia

- [Execute Queries in Group](https://learn.microsoft.com/en-us/rest/api/power-bi/datasets/execute-queries-in-group)
- [Execute Queries](https://learn.microsoft.com/en-us/rest/api/power-bi/datasets/execute-queries)

Límites de la API: 100.000 filas o 1.000.000 de valores por consulta, 15 MB y
120 consultas por minuto y por usuario. Cada informe pide sólo lo suyo.
