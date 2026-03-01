FROM node:20-slim

# Install Chromium and minimal dependencies
RUN apt-get update && apt-get install -y \
    chromium \
    ca-certificates \
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
    libxss1 \
    libdbus-1-3 \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*

# Run as non-root user for security
RUN groupadd -r openchrome && useradd -r -g openchrome -m openchrome

# Set Chrome path for OpenChrome auto-detection
ENV CHROME_PATH=/usr/bin/chromium
ENV DOCKER=true

# Install OpenChrome globally
RUN npm install -g openchrome-mcp

USER openchrome

# Default command: server mode
CMD ["openchrome", "serve", "--server-mode"]
