# Build stage - onde compilamos os módulos nativos
FROM node:22-alpine AS builder

WORKDIR /app

# Instalar apenas ferramentas de build necessárias
RUN apk add --no-cache \
    make \
    g++ \
    python3 \
    py3-pip \
    git

ENV PYTHON=/usr/bin/python3

# Copiar código local e instalar dependências
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && \
    npm cache clean --force && \
    rm -rf /root/.npm /tmp/*
COPY . .

# Production stage - imagem final mínima
FROM node:22-alpine AS production

LABEL maintainer="Giovane Heleno" \
      version="2.2.7" \
      description="ISP Tools Probe - Network diagnostic tools"

WORKDIR /app

# Instalar apenas runtime essenciais
RUN apk add --no-cache \
    dumb-init \
    wget \
    git \
    dcron \
    fping && \
    npm install -g pm2@latest && \
    npm cache clean --force

# Copiar apenas os arquivos compilados do stage anterior
COPY --from=builder /app .

# Limpar arquivos desnecessários (mantendo .git para o cron)
RUN rm -rf \
    .github \
    v1 \
    v2-nodejs.zip \
    test.yml \
    test_run.sh \
    *.md \
    /root/.npm \
    /tmp/*

# O crontab (git pull a cada 10 min) é instalado na partida por cron-setup.sh:
# PROBE_GIT_PULL=0 desliga o git pull (imagens versionadas do NOC); sem a env, continua ligado.

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=10 \
    CMD wget --no-verbose --tries=1 --spider http://0.0.0.0:8000/ || exit 1

ENTRYPOINT ["/usr/bin/dumb-init", "--"]

CMD ["sh", "-c", "sh /app/cron-setup.sh || true; crond && pm2-runtime start ecosystem.config.cjs --env production"]

