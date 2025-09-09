# Dockerfile (tested pattern for headless Chromium + Node 18)
FROM node:18-bullseye-slim

ENV DEBIAN_FRONTEND=noninteractive
ENV TZ=Etc/UTC

# Install system deps and chromium
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    gnupg \
    dirmngr \
    build-essential \
    python3 \
    xz-utils \
    fonts-liberation \
    libappindicator3-1 \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdbus-1-3 \
    libgdk-pixbuf2.0-0 \
    libnspr4 \
    libnss3 \
    libx11-6 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    xdg-utils \
    libxss1 \
    libgbm1 \
    wget \
    git \
    chromium \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/*

# Create and use app dir
WORKDIR /app

# Copy package files first for caching
COPY package*.json ./

# Install node deps
RUN npm ci --production || npm install --production

# Copy app sources
COPY . .

# Expose port
EXPOSE 7777

# Default env vars (override in Render)
ENV PORT=7777
ENV CHROMIUM_PATH=/usr/bin/chromium
ENV DUMP_IO=false

CMD ["node", "server.js"]
