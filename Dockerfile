FROM node:22-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      chromium \
      fonts-noto-cjk \
      ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
COPY server.js ./
COPY index.html ./
COPY README.md ./

ENV NODE_ENV=production
ENV CHROME_PATH=/usr/bin/chromium
ENV CHROME_NO_SANDBOX=1
ENV WORKSPACE_DIR=/app/data

RUN mkdir -p /app/data/uploads /app/data/captures

EXPOSE 8030

CMD ["npm", "start"]
