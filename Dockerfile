# Dockerfile - Debian slim with Chromium
FROM debian:stable-slim

# Install node (LTS) and needed libs for Chromium
ENV NODE_VERSION=18

# Install dependencies for Chrome + node build
RUN apt-get update && apt-get install -y --no-install-recommends \
  ca-certificates \
  curl \
  gnupg \
  dirmngr \
  build-essential \
  python3 \
  xz-utils \
  apt-transport-https \
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
  ca-certificates \
  wget \
  git \
  && rm -rf /var/lib/apt/lists/*

# Install Node.js LTS
RUN curl -fsSL https://deb.nodesource.com/setup_18.x | bash - \
  && apt-get install -y nodejs \
  && node -v && npm -v

# Install Chromium (Debian's chromium)
RUN apt-get update && apt-get install -y chromium \
  && rm -rf /var/lib/apt/lists/*

# Create app dir
WORKDIR /app
COPY package.json package-lock.json* ./ || true
COPY . .

# Install dependencies
RUN npm ci --production || npm install --production

# Expose port (Render will set PORT env)
EXPOSE 7777

# Default env vars (override in Render UI if needed)
ENV PORT=7777
ENV CHROMIUM_PATH=/usr/bin/chromium
ENV DUMP_IO=false

# Start
CMD ["node", "server.js"]
