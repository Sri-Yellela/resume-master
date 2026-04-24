FROM node:20-bullseye-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    wget ca-certificates gnupg \
    chromium \
    libnspr4 \
    libnss3 \
    libnss3-dev \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libgbm1 \
    libglib2.0-0 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libxfixes3 \
    libxext6 \
    libx11-xcb1 \
    libxcb-dri3-0 \
    libpango-1.0-0 \
    libcairo2 \
    libasound2 \
    libdbus-1-3 \
    libexpat1 \
    libfontconfig1 \
    libpangocairo-1.0-0 \
    libx11-6 \
    libxcb1 \
    libxcomposite1 \
    libxi6 \
    libxtst6 \
    fonts-liberation \
    fonts-noto-color-emoji \
    && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# Server dependencies
COPY package*.json ./
RUN npm install

# Client dependencies and build
COPY client/package*.json ./client/
RUN cd client && npm install
COPY client/ ./client/
COPY shared/ ./shared/
RUN cd client && npm run build

# Copy remaining server source
COPY . .

EXPOSE 3000

CMD ["node", "server.js"]
