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
| `backend/powerbi/` | `auth.js` (token de Entra), `client.js` (Execute Queries), `queries.js` (helpers DAX). |
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

```bash
cd backend
npm install
cp .env.example .env     # completá TENANT_ID, CLIENT_ID, CLIENT_SECRET y los IDs
node prueba-api.js       # que esto pase ANTES de seguir
npm start
```

Después abrí `http://localhost:3000/informes-powerbi.html`: el artefacto queda
servido desde el mismo origen que la API, así que **Actualizar datos** consulta
Power BI de verdad.

### De dónde salen los IDs

De la URL del reporte en Power BI Service:

```
.../groups/{workspaceId}/reports/{reportId}/...
```

El **Dataset / modelo semántico ID** está en el elemento *Modelo semántico*
asociado al reporte dentro del mismo workspace.

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
- `ORIGENES_PERMITIDOS` es una lista explícita: nunca `*`.
- Service Principal **no es compatible** con datasets con RLS ni con SSO
  habilitado. Verificalo antes de construir (manual, paso 4).

## Referencia

- [Execute Queries in Group](https://learn.microsoft.com/en-us/rest/api/power-bi/datasets/execute-queries-in-group)
- [Execute Queries](https://learn.microsoft.com/en-us/rest/api/power-bi/datasets/execute-queries)

Límites de la API: 100.000 filas o 1.000.000 de valores por consulta, 15 MB y
120 consultas por minuto y por usuario. Cada informe pide sólo lo suyo.
