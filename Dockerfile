FROM node:18-bookworm-slim
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-pip \
    && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
COPY requirements-tts.txt ./
RUN npm ci --omit=dev \
    && python3 -m pip install --break-system-packages -r requirements-tts.txt
COPY . .
EXPOSE 3000
CMD ["node", "src/server.js"]
