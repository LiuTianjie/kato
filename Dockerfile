FROM node:22-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json tsconfig.json ./
COPY src ./src
RUN npm ci && npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    XHS_BROWSER_BIN=/usr/local/bin/kato-chromium \
    XHS_CDP_HOST=127.0.0.1 \
    XHS_CDP_PORT=9224 \
    XHS_INTERNAL_CDP_PORT=9224 \
    XHS_DISPLAY=:99 \
    XHS_VNC_ENABLED=1 \
    XHS_VNC_PORT=5900 \
    XHS_NOVNC_PORT=6080 \
    XHS_PROFILE_DIR=/app/mcp/xiaohongshu/data/profile \
    COOKIES_PATH=/app/mcp/xiaohongshu/data/cookies.json \
    PORT=4173 \
    XHS_SERVICE_PORT=18060

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    fonts-wqy-zenhei \
    gnupg \
    locales \
    tini \
    wget \
    xauth \
    x11vnc \
    xdotool \
    novnc \
    websockify \
    xvfb \
  && wget -q -O- https://dl.google.com/linux/linux_signing_key.pub \
    | gpg --dearmor -o /usr/share/keyrings/google-linux-signing-keyring.gpg \
  && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-linux-signing-keyring.gpg] http://dl.google.com/linux/chrome/deb/ stable main" \
    > /etc/apt/sources.list.d/google-chrome.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends google-chrome-stable \
  && sed -i 's/# zh_CN.UTF-8 UTF-8/zh_CN.UTF-8 UTF-8/' /etc/locale.gen \
  && locale-gen \
  && rm -rf /var/lib/apt/lists/*

ENV LANG=zh_CN.UTF-8 \
    LC_ALL=zh_CN.UTF-8 \
    LANGUAGE=zh_CN:zh

WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json package-lock.json ./
COPY public ./public
COPY xhs.config.example.json ./
COPY mcp/xiaohongshu/service ./mcp/xiaohongshu/service
COPY scripts/start-kato.sh ./scripts/start-kato.sh
COPY scripts/kato-chromium.sh /usr/local/bin/kato-chromium

RUN chmod +x ./scripts/start-kato.sh /usr/local/bin/kato-chromium \
  && mkdir -p /app/data /app/output /app/mcp/xiaohongshu/data /app/mcp/xiaohongshu/images

EXPOSE 4173 18060

HEALTHCHECK --interval=30s --timeout=25s --start-period=60s --retries=3 \
  CMD node -e "const urls=['http://127.0.0.1:'+(process.env.PORT||4173)+'/api/dashboard','http://127.0.0.1:'+(process.env.XHS_SERVICE_PORT||18060)+'/health?ensure=1']; Promise.all(urls.map((url)=>fetch(url,{signal:AbortSignal.timeout(20000)}).then((r)=>{if(!r.ok) throw new Error(url+' '+r.status)}))).then(()=>process.exit(0)).catch((e)=>{console.error(e.message);process.exit(1)})"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["./scripts/start-kato.sh"]
