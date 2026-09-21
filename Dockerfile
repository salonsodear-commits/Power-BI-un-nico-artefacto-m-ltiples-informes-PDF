# Para sacar el backend de un Codespace.
#
# Un Codespace es un entorno de desarrollo atado a una cuenta de GitHub: el
# puerto nace privado y, abierto a otra computadora, lo primero que pide es
# entrar a GitHub. Eso es justo lo que no se quiere — la única credencial que
# alguien del equipo tiene que poner es la de Microsoft.
#
# Esta imagen corre en cualquier lado que acepte un contenedor: Azure Container
# Apps, Azure App Service, Render, Fly, Railway, o una máquina de la empresa.
#
#   docker build -t tablero-a-informe .
#   docker run -p 3000:3000 -e TENANT_ID=… -e CLIENT_ID=… tablero-a-informe
#
# El CLIENT_SECRET no hace falta: el modo delegado usa el código de
# dispositivo, sin secreto. Si igual se usa, va como variable de entorno del
# host —nunca en la imagen, nunca en el repositorio—.
FROM node:22-alpine

# `tini` para que Ctrl-C y el apagado del host lleguen a Node como una señal,
# y no queden procesos zombi en el contenedor.
RUN apk add --no-cache tini

WORKDIR /app

# Primero los manifiestos: así el `npm ci` se recicla mientras no cambien las
# dependencias, que es lo que hace lento a un build.
COPY package.json package-lock.json* ./
COPY backend/package.json ./backend/
RUN npm ci --omit=dev --workspaces --include-workspace-root

COPY backend ./backend
COPY artefacto ./artefacto

# El mapeo en uso y las sesiones se escriben acá. Con el contenedor efímero se
# pierden al reiniciar: el mapeo se vuelve a detectar solo —es una consulta— y
# cada uno entra de nuevo con su cuenta. Para que sobrevivan, montar un volumen
# en /app/backend.
ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

# Sin root: si algo se escapa, que no sea dueño del contenedor.
RUN chown -R node:node /app
USER node

HEALTHCHECK --interval=30s --timeout=4s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/informes').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "backend/server.js"]
