# Serves the Dock web app and its network relay from one small container.
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server ./server
COPY web ./web
ENV PORT=8080
EXPOSE 8080
CMD ["node", "server/relay.mjs"]
