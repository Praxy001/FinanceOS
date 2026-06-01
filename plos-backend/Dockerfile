FROM node:22-slim

# Install build tools for native modules (if any)
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

# Create data directory for SQLite DB
RUN mkdir -p /data

ENV PORT=3000
ENV DB_PATH=/data/plos.db

EXPOSE 3000

CMD ["node", "server.js"]
