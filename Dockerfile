FROM node:20-bookworm-slim
WORKDIR /app
COPY package*.json ./
COPY vendor/ ./vendor/
RUN npm ci --omit=dev
COPY . .
EXPOSE 3100
CMD ["node", "server.js"]
