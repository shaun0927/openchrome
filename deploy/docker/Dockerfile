# OpenChrome MCP Server — Production Docker Image
# Build:  docker build -t openchrome -f deploy/docker/Dockerfile .
# Run:    docker run -p 3100:3100 -p 9090:9090 openchrome

FROM node:22-slim AS builder

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json tsconfig.cli.json ./
COPY src/ src/
COPY cli/ cli/
RUN npm run build

FROM node:22-slim

# Install Chrome dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    fonts-liberation \
    libnss3 \
    libatk-bridge2.0-0 \
    libdrm2 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libgbm1 \
    libasound2 \
    libpangocairo-1.0-0 \
    libgtk-3-0 \
    ca-certificates \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Create non-root user
RUN groupadd -r openchrome && useradd -r -g openchrome -m openchrome

WORKDIR /app

# Copy built artifacts and production dependencies
COPY --from=builder /app/dist/ dist/
COPY --from=builder /app/node_modules/ node_modules/
COPY package.json ./

# Create data directory
RUN mkdir -p /home/openchrome/.openchrome && chown -R openchrome:openchrome /home/openchrome

USER openchrome

# Environment defaults
ENV CHROME_BINARY=/usr/bin/chromium
ENV NODE_ENV=production
ENV OPENCHROME_MAX_RECONNECT_ATTEMPTS=0
ENV OPENCHROME_EVENT_LOOP_FATAL_MS=30000
ENV OPENCHROME_HEALTH_BIND=0.0.0.0

# Expose ports: MCP HTTP transport + Health endpoint
EXPOSE 3100 9090

# Health check using the built-in health endpoint
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD curl -sf http://localhost:9090/health || exit 1

# Start in HTTP daemon mode
CMD ["node", "dist/index.js", "serve", "--http", "3100", "--auto-launch", "--server-mode"]
