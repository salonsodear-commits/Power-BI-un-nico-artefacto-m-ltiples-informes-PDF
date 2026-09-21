#!/usr/bin/env bash
#
# Deja el backend corriendo en Azure, para que el equipo entre sólo con su
# cuenta de Microsoft.
#
# Por qué Azure y no el Codespace: un Codespace está atado a UNA cuenta de
# GitHub, así que desde otra computadora lo primero que pide es entrar a
# GitHub — la credencial que justamente no hay que compartir— y además se
# apaga solo. Acá la dirección es estable y lo único que se pide es Microsoft.
#
# No hace falta Docker en tu máquina: `az acr build` compila la imagen en
# Azure. Tampoco hace falta CLIENT_SECRET: el ingreso es por código de
# dispositivo, que es un cliente público, sin secreto que proteger.
#
#   ./desplegar/azure.sh
#
# Antes: `az login`, y tener los dos IDs de la app de Entra a mano.
set -euo pipefail

# ── lo que se puede cambiar ──────────────────────────────────────────────
GRUPO="${GRUPO:-rg-tablero-informe}"
REGION="${REGION:-brazilsouth}"          # la más cercana con Container Apps
ENTORNO="${ENTORNO:-env-tablero}"
APP="${APP:-tablero-a-informe}"
# el nombre del registro tiene que ser único en todo Azure y sólo minúsculas
REGISTRO="${REGISTRO:-acr$(echo "$APP" | tr -cd 'a-z0-9')$RANDOM}"
TAG="${TAG:-$(date +%Y%m%d%H%M)}"

: "${TENANT_ID:?Falta TENANT_ID (el «id de directorio (inquilino)» de la app de Entra)}"
: "${CLIENT_ID:?Falta CLIENT_ID (el «id de aplicación (cliente)»)}"

raiz="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$raiz"

echo "── grupo y entorno ──"
az group create -n "$GRUPO" -l "$REGION" -o none
az containerapp env create -n "$ENTORNO" -g "$GRUPO" -l "$REGION" -o none

echo "── imagen (se compila en Azure, no acá) ──"
az acr create -n "$REGISTRO" -g "$GRUPO" --sku Basic --admin-enabled true -o none
az acr build -r "$REGISTRO" -t "$APP:$TAG" . -o none

echo "── la aplicación ──"
# Una sola réplica, a propósito: las sesiones viven en el proceso, y con dos
# la mitad de las llamadas caería en la que no tiene la sesión de esa persona.
az containerapp create \
  -n "$APP" -g "$GRUPO" --environment "$ENTORNO" \
  --image "$REGISTRO.azurecr.io/$APP:$TAG" \
  --registry-server "$REGISTRO.azurecr.io" \
  --target-port 3000 --ingress external \
  --min-replicas 1 --max-replicas 1 \
  --env-vars "TENANT_ID=$TENANT_ID" "CLIENT_ID=$CLIENT_ID" "NODE_ENV=production" \
  -o none

url="https://$(az containerapp show -n "$APP" -g "$GRUPO" --query properties.configuration.ingress.fqdn -o tsv)"
echo
echo "Listo: $url"
echo
echo "Esa dirección es la que se reparte al equipo. Cada uno entra con SU"
echo "cuenta de Microsoft y ve lo que Power BI le deja ver."
echo
echo "Para actualizar después de un cambio:"
echo "  az acr build -r $REGISTRO -t $APP:nuevo . && \\"
echo "  az containerapp update -n $APP -g $GRUPO --image $REGISTRO.azurecr.io/$APP:nuevo"
