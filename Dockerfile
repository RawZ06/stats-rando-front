# ---- Base : Node 22 Alpine ----
FROM node:22-alpine

# 1) Dépendances nécessaires à Chromium + polices
RUN apk add --no-cache \
    chromium \
    nss \
    freetype \
    harfbuzz \
    ca-certificates \
    ttf-freefont \
    font-noto-emoji

# 2) Puppeteer utilisera le Chromium système (pas de download)
ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser

# 3) Dossier de travail
WORKDIR /app

# 4) Installation deps (pnpm pris en charge via corepack)
#    -> si tu n'utilises pas pnpm, remplace par "COPY package*.json ./ && npm ci"
RUN corepack enable

# Copie des manifests puis install
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# 5) Copie du code
COPY . .

# 6) Env & port
ENV NODE_ENV=production
EXPOSE 3000

# 7) Lancement
CMD ["node", "server.js"]