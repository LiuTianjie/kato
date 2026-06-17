FROM node:22-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json tsconfig.json ./
COPY src ./src
RUN npm ci && npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim AS browser-runtime

ENV NODE_ENV=production \
    TZ=Asia/Shanghai \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    BROWSER_TIMEZONE_ID=Asia/Shanghai \
    BROWSER_RUNTIME_PORT=18100 \
    BROWSER_BIN=/usr/local/bin/kato-chromium \
    BROWSER_CDP_HOST=127.0.0.1 \
    BROWSER_CDP_PORT=9224 \
    BROWSER_DISPLAY=:99 \
    BROWSER_DISPLAY_SIZE=1440x980x24 \
    BROWSER_VNC_ENABLED=1 \
    BROWSER_VNC_PORT=5900 \
    BROWSER_NOVNC_PORT=6080 \
    BROWSER_PROFILE_DIR=/app/data/browser-profile \
    BROWSER_COOKIES_PATH=/app/data/cookies.json \
    BROWSER_CHROME_USER=kato \
    BROWSER_CHROME_NO_SANDBOX=1 \
    XHS_BROWSER_BIN=/usr/local/bin/kato-chromium \
    XHS_CDP_HOST=127.0.0.1 \
    XHS_CDP_PORT=9224 \
    XHS_INTERNAL_CDP_PORT=9224 \
    XHS_DISPLAY=:99 \
    XHS_VNC_ENABLED=1 \
    XHS_VNC_PORT=5900 \
    XHS_NOVNC_PORT=6080 \
    XHS_CHROME_USER=kato \
    XHS_TIMEZONE_ID=Asia/Shanghai \
    XHS_CHROME_NO_SANDBOX=1

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    fonts-wqy-zenhei \
    gnupg \
    locales \
    tini \
    tzdata \
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

RUN groupadd --system kato \
  && useradd --system --gid kato --home-dir /home/kato --create-home --shell /usr/sbin/nologin kato

COPY browser-runtime ./browser-runtime
COPY scripts/kato-chromium.sh /usr/local/bin/kato-chromium
COPY scripts/kato-xdg-open-stub.sh /usr/local/bin/xdg-open

RUN chmod +x /app/browser-runtime/bin/start-browser-runtime.sh /usr/local/bin/kato-chromium /usr/local/bin/xdg-open \
  && mkdir -p /app/data \
  && chown -R kato:kato /home/kato /app/data

EXPOSE 18100

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/app/browser-runtime/bin/start-browser-runtime.sh"]

FROM browser-runtime AS kato

ENV PORT=4173 \
    TZ=Asia/Shanghai \
    BROWSER_TIMEZONE_ID=Asia/Shanghai \
    XHS_TIMEZONE_ID=Asia/Shanghai \
    XHS_SERVICE_PORT=18060 \
    DOUYIN_SERVICE_PORT=18070 \
    BILIBILI_SERVICE_PORT=18080 \
    XHS_VIEWER_RUNTIME_URL=http://127.0.0.1:18100 \
    XHS_BROWSER_RUNTIME_URL=http://127.0.0.1:18101 \
    DOUYIN_VIEWER_RUNTIME_URL=http://127.0.0.1:18110 \
    DOUYIN_BROWSER_RUNTIME_URL=http://127.0.0.1:18111 \
    BILIBILI_VIEWER_RUNTIME_URL=http://127.0.0.1:18120 \
    BILIBILI_BROWSER_RUNTIME_URL=http://127.0.0.1:18121 \
    BILIBILI_SERVICE_URL=http://127.0.0.1:18080 \
    BROWSER_VIEWER_RUNTIME_URL=http://127.0.0.1:18100 \
    BROWSER_WORKER_RUNTIME_URL=http://127.0.0.1:18101 \
    BROWSER_RUNTIME_URL=http://127.0.0.1:18101 \
    BROWSER_RUNTIME_PORT=18101 \
    XHS_INTERNAL_CDP_PORT=9225 \
    DOUYIN_INTERNAL_CDP_PORT=9235 \
    BILIBILI_INTERNAL_CDP_PORT=9245 \
    XHS_PROFILE_DIR=/app/data/platforms/xhs/worker-profile \
    XHS_STORAGE_PATH=/app/data/platforms/xhs/storage.json \
    DOUYIN_PROFILE_DIR=/app/data/platforms/douyin/worker-profile \
    BILIBILI_PROFILE_DIR=/app/data/platforms/bilibili/worker-profile \
    COOKIES_PATH=/app/mcp/xiaohongshu/data/cookies.json \
    DOUYIN_COOKIES_PATH=/app/data/platforms/douyin/cookies.json \
    BILIBILI_COOKIES_PATH=/app/data/platforms/bilibili/cookies.json

WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json package-lock.json ./
COPY public ./public
COPY xhs.config.example.json ./
COPY mcp/xiaohongshu/service ./mcp/xiaohongshu/service
COPY mcp/douyin/service ./mcp/douyin/service
COPY mcp/bilibili/service ./mcp/bilibili/service
COPY scripts/start-kato.sh ./scripts/start-kato.sh

RUN chmod +x ./scripts/start-kato.sh \
  && mkdir -p /app/data /app/output /app/data/platforms/xhs /app/data/platforms/douyin /app/data/platforms/bilibili /app/mcp/xiaohongshu/data /app/mcp/xiaohongshu/images \
  && chown -R kato:kato /home/kato /app/data /app/mcp/xiaohongshu/data /app/mcp/xiaohongshu/images

EXPOSE 4173 18060 18070 18080

HEALTHCHECK --interval=30s --timeout=25s --start-period=60s --retries=3 \
  CMD node -e "const e=process.env; const urls=['http://127.0.0.1:'+(e.PORT||4173)+'/api/auth/status','http://127.0.0.1:'+(e.XHS_SERVICE_PORT||18060)+'/health?ensure=1','http://127.0.0.1:'+(e.DOUYIN_SERVICE_PORT||18070)+'/health?ensure=1','http://127.0.0.1:'+(e.BILIBILI_SERVICE_PORT||18080)+'/health','http://127.0.0.1:'+(e.XHS_VIEWER_RUNTIME_PORT||18100)+'/health?ensure=1','http://127.0.0.1:'+(e.XHS_WORKER_RUNTIME_PORT||e.BROWSER_RUNTIME_PORT||18101)+'/health?ensure=1','http://127.0.0.1:'+(e.DOUYIN_VIEWER_RUNTIME_PORT||18110)+'/health?ensure=1','http://127.0.0.1:'+(e.DOUYIN_WORKER_RUNTIME_PORT||18111)+'/health?ensure=1','http://127.0.0.1:'+(e.BILIBILI_VIEWER_RUNTIME_PORT||18120)+'/health?ensure=1','http://127.0.0.1:'+(e.BILIBILI_WORKER_RUNTIME_PORT||18121)+'/health?ensure=1']; Promise.all(urls.map((url)=>fetch(url,{signal:AbortSignal.timeout(20000)}).then((r)=>{if(!r.ok) throw new Error(url+' '+r.status)}))).then(()=>process.exit(0)).catch((e)=>{console.error(e.message);process.exit(1)})"

CMD ["./scripts/start-kato.sh"]
