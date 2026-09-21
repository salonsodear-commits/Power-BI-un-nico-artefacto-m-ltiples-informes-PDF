#!/usr/bin/env bash
#
# Deja el backend corriendo en Azure, para que el equipo entre sólo con su
# cuenta de Microsoft.
#
# Por qué no el Codespace: está atado a UNA cuenta de GitHub, así que desde
# otra computadora lo primero que pide es entrar a GitHub —la credencial que
# justamente no hay que compartir— y además se apaga solo. Acá la dirección
# es estable y lo único que se pide es Microsoft.
#
# No hace falta Docker en tu máquina: `az acr build` compila la imagen en
# Azure. Tampoco hace falta CLIENT_SECRET: el ingreso es por código de
# dispositivo, que es un cliente público, sin secreto que proteger.
#
#   az login --use-device-code
#   TENANT_ID=… CLIENT_ID=… ./desplegar/azure.sh
#
# Se puede correr todas las veces que haga falta: si algo ya existe, lo
# reusa; si la aplicación ya está, la actualiza.
set -euo pipefail

GRUPO="${GRUPO:-rg-tablero-informe}"
REGION="${REGION:-brazilsouth}"
ENTORNO="${ENTORNO:-env-tablero}"
APP="${APP:-tablero-a-informe}"
# el nombre del registro va en una dirección pública: sólo minúsculas y
# números, único en todo Azure. Se deriva del inquilino para que sea estable
# entre corridas —si cambiara, cada vez se crearía un registro nuevo—.
REGISTRO="${REGISTRO:-}"

paso() { printf "\n\033[1m── %s\033[0m\n" "$1"; }
morir() { printf "\n\033[31m✗ %s\033[0m\n" "$1" >&2; exit 1; }

# ── 0 · que estén las herramientas y la sesión ───────────────────────────
command -v az >/dev/null 2>&1 || morir \
  "No encuentro el comando 'az'. Instalá la CLI de Azure:
   curl -sL https://aka.ms/InstallAzureCLIDeb | sudo bash"

az account show >/dev/null 2>&1 || morir \
  "No hay sesión de Azure. Entrá primero:
   az login --use-device-code"

: "${TENANT_ID:?Falta TENANT_ID — el «id de directorio (inquilino)» de la app de Entra}"
: "${CLIENT_ID:?Falta CLIENT_ID — el «id de aplicación (cliente)» de la app de Entra}"

suscripcion="$(az account show --query name -o tsv)"
idSuscripcion="$(az account show --query id -o tsv)"
printf "Suscripción: \033[1m%s\033[0m (%s)\n" "$suscripcion" "$idSuscripcion"
printf "Si no es ésa, cortá y corré: az account set --subscription \"NOMBRE\"\n"

if [ -z "$REGISTRO" ]; then
  REGISTRO="acr$(printf %s "$idSuscripcion" | tr -d '-' | cut -c1-16)"
fi

raiz="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$raiz"

# ── 1 · lo que Azure exige antes de poder crear nada ─────────────────────
paso "Preparando la suscripción (la primera vez tarda unos minutos)"
az extension add --name containerapp --upgrade --allow-preview true --only-show-errors -o none
# Sin estos dos registros, «az containerapp env create» falla con un error que
# no dice qué hacer. Son idempotentes: si ya están, vuelven enseguida.
az provider register --namespace Microsoft.App --wait -o none
az provider register --namespace Microsoft.OperationalInsights --wait -o none

# ── 2 · grupo y entorno ──────────────────────────────────────────────────
paso "Grupo de recursos y entorno de Container Apps"
az group create -n "$GRUPO" -l "$REGION" -o none
if ! az containerapp env show -n "$ENTORNO" -g "$GRUPO" -o none 2>/dev/null; then
  az containerapp env create -n "$ENTORNO" -g "$GRUPO" -l "$REGION" -o none \
    || morir "No se pudo crear el entorno en '$REGION'.
   Puede que Container Apps no esté disponible ahí. Probá con otra:
   REGION=eastus ./desplegar/azure.sh"
fi

# ── 3 · la imagen, compilada en Azure ────────────────────────────────────
paso "Compilando la imagen (no hace falta Docker acá)"
az acr show -n "$REGISTRO" -o none 2>/dev/null \
  || az acr create -n "$REGISTRO" -g "$GRUPO" --sku Basic --admin-enabled true -o none
TAG="$(date +%Y%m%d%H%M%S)"
az acr build -r "$REGISTRO" -t "$APP:$TAG" . -o none

# ── 4 · la aplicación ────────────────────────────────────────────────────
# Una sola réplica, a propósito: las sesiones viven en el proceso, y con dos
# la mitad de las llamadas caería en la que no tiene la sesión de esa persona.
imagen="$REGISTRO.azurecr.io/$APP:$TAG"
if az containerapp show -n "$APP" -g "$GRUPO" -o none 2>/dev/null; then
  paso "Actualizando la aplicación"
  az containerapp update -n "$APP" -g "$GRUPO" --image "$imagen" -o none
else
  paso "Creando la aplicación"
  az containerapp create \
    -n "$APP" -g "$GRUPO" --environment "$ENTORNO" \
    --image "$imagen" --registry-server "$REGISTRO.azurecr.io" \
    --target-port 3000 --ingress external \
    --min-replicas 1 --max-replicas 1 \
    --env-vars "TENANT_ID=$TENANT_ID" "CLIENT_ID=$CLIENT_ID" "NODE_ENV=production" \
    -o none
fi

url="https://$(az containerapp show -n "$APP" -g "$GRUPO" \
  --query properties.configuration.ingress.fqdn -o tsv)"

paso "Listo"
printf "\n   \033[1m%s\033[0m\n\n" "$url"
cat <<FIN
   Esa dirección es la que se reparte al equipo. Cada uno la abre, entra con
   SU cuenta de Microsoft, y ve lo que Power BI le deja ver. Ni GitHub, ni
   archivos, ni nada que configurar.

   Para actualizar después de un cambio, volvé a correr este mismo script.
   Para ver qué está pasando adentro:
     az containerapp logs show -n $APP -g $GRUPO --follow
   Para borrar todo:
     az group delete -n $GRUPO --yes
FIN
