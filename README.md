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
npm install                                  # instala backend/ (workspace)
cp backend/.env.example backend/.env         # completá credenciales e IDs
npm run prueba                               # que esto pase ANTES de seguir
npm run dev                                  # o npm start, sin recarga
```

Después abrí `http://localhost:3000/`: el artefacto queda servido desde el mismo
origen que la API, así que **Actualizar datos** consulta Power BI de verdad.
En Codespaces, abrí el puerto 3000 reenviado y ya caés en el artefacto.

Sin `.env` el servidor arranca igual y sirve el artefacto: podés trabajar con
**Datos de ejemplo** y **Pegar JSON**. Sólo *Actualizar datos* necesita
credenciales.

| Comando | Qué hace |
|---|---|
| `npm run dev` | Levanta el backend con recarga al guardar. |
| `npm start` | Igual, sin recarga. |
| `npm run prueba` | Token + workspace + dataset + un `EVALUATE` mínimo. |

### Vincular con tu modelo semántico

Con el backend levantado, **Conectar a Power BI** hace todo el vínculo sin tocar
código. Tiene tres pestañas:

1. **Tablero** — el backend llama a `GET /groups` y `GET /groups/{ws}/datasets` y
   te muestra los workspaces y modelos que ve esta identidad, con qué reportes
   usa cada modelo. Elegís y quedan cargados los IDs.
2. **Mapeo del modelo** — los informes piden campos logicos (*Real*, *BO*,
   *Vertical*...) y aca se traducen a los nombres de **tu** modelo:
   `[Facturacion Neta]`, `'Dim Calendario'[AnioMes]`, `Dim_UN[Descripcion]`.
   **Verificar contra el modelo** prueba cada referencia con un `EVALUATE`
   minimo y marca si existe, una por una. Lo que dejes vacio, el informe lo
   saltea.
3. **Consola DAX** — ejecuta cualquier consulta de lectura contra el modelo. Es
   la forma de descubrir como se llaman tus medidas antes de mapearlas.

El mapeo se guarda en `backend/modelo.json`. No tiene secretos: podes
commitearlo para que lo comparta el equipo.

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

Los marcados con `*` son obligatorios. `periodo` debe ser una columna con el
**entero AAAAMM** (202607): DAX no agrupa por expresiones, asi que una columna
de fecha no sirve para las series de evolucion. Si no la tenes, agrega al modelo
una columna calculada `YEAR([Fecha])*100 + MONTH([Fecha])`.

`variacion` se toma del modelo si existe; si no, el backend usa `real - bo`. Es
la unica cuenta que hace, y solo porque una resta no es logica de negocio que
pueda diferir del tablero.

### Rutas del backend

| Ruta | Para que |
|---|---|
| `GET /api/powerbi/workspaces` | Workspaces visibles. |
| `GET /api/powerbi/workspaces/:ws/modelos` | Modelos semanticos y sus reportes. |
| `GET /api/powerbi/modelos/:ws/:ds/medidas` | Medidas via INFO, si el modelo las admite. |
| `POST /api/powerbi/dax` | Consola DAX de solo lectura. |
| `GET` / `PUT /api/modelo` | Leer y guardar el mapeo. |
| `POST /api/modelo/verificar` | Probar cada referencia contra el modelo. |
| `POST /api/informe` | El informe ya normalizado. |

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

Las tablas largas se cortan solas por filas y siguen en la hoja siguiente con el
encabezado repetido.

## Agregar un informe nuevo

No se crea otro artefacto. Se agrega un archivo en `backend/informes/` con
`{ meta, consultas, construir }` y se lo registra en `informes/index.js`; el
selector del artefacto lo muestra solo. `gerencia.js` es el ejemplo más corto:
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

- El `CLIENT_SECRET` vive sólo en `backend/.env`, que está en `.gitignore`.
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
