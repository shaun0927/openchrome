FROM node:20-slim

# Install Chromium and minimal dependencies
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-liberation \
    libgbm1 \
    libasound2 \
    libatk-bridge2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Set Chrome path for OpenChrome auto-detection
ENV CHROME_PATH=/usr/bin/chromium
ENV DOCKER=true

# Install OpenChrome globally
RUN npm install -g openchrome-mcp

# Default command: server mode
CMD ["openchrome", "serve", "--server-mode"]
