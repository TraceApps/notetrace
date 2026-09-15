# ── Stage 1: Build Svelte frontend ──────────────────────────────────────────
FROM --platform=$BUILDPLATFORM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
# scripts/postinstall.cjs is referenced by the "postinstall" npm hook, so it
# must exist before npm install runs. Copy it explicitly here so we don't
# bust the rest of the source-code Docker layer cache on every change.
COPY scripts/ ./scripts/
RUN npm install
COPY . .
RUN npm run build

# ── Stage 1b: a small audio-only ffmpeg ─────────────────────────────────────
# Converts voice recordings imported from Google Keep (3GP/AMR) to M4A and
# splits long recordings for transcription. Built with only the audio formats
# NoteTrace handles, so it adds a few MB instead of a full ffmpeg's 125 MB.
FROM node:20-alpine AS ffmpeg
RUN apk add --no-cache build-base curl xz
ARG FFMPEG_VERSION=7.1.1
RUN curl -fsSL https://ffmpeg.org/releases/ffmpeg-${FFMPEG_VERSION}.tar.xz | tar -xJ -C /tmp \
 && cd /tmp/ffmpeg-${FFMPEG_VERSION} \
 && ./configure --prefix=/opt/ffmpeg --disable-everything --disable-autodetect --disable-doc --disable-debug \
      --disable-network --disable-x86asm --disable-ffplay --enable-small \
      --enable-protocol=file,pipe \
      --enable-demuxer=mov,matroska,ogg,mp3,wav,flac,amr,aac \
      --enable-decoder=aac,opus,libopus,vorbis,mp3,mp3float,flac,pcm_s16le,pcm_s24le,pcm_f32le,amrnb,amrwb \
      --enable-parser=aac,opus,vorbis,mpegaudio,flac \
      --enable-encoder=aac \
      --enable-muxer=ipod,mp4,segment,wav,webm,ogg,matroska \
      --enable-filter=aresample,aformat,anull \
      --enable-swresample \
 && make -j"$(nproc)" && make install && strip /opt/ffmpeg/bin/ffmpeg /opt/ffmpeg/bin/ffprobe

# ── Stage 2: Express server + static frontend ────────────────────────────────
FROM node:20-alpine
# python3 + make + g++ are needed by better-sqlite3's native build.
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY server/package*.json ./
RUN npm install --omit=dev
COPY server/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh
COPY server/ .
COPY --from=build /app/dist ./dist
COPY --from=ffmpeg /opt/ffmpeg/bin/ffmpeg /opt/ffmpeg/bin/ffprobe /usr/local/bin/
# Also ship the root package.json so the server can read APP_VERSION
# from it at runtime. The `COPY server/package*.json ./` step above
# put the SERVER package.json at /app/package.json; overwriting it
# with the ROOT one here makes version-source.js report the correct
# client-facing version instead of the stale server-side one.
COPY --from=build /app/package.json ./package.json
# Bake the app version into the image so the in-app updates checker
# can report the running server version. CI can pass
# `--build-arg APP_VERSION=$(node -p 'require("./package.json").version')`.
# Falls back to reading /app/package.json at runtime.
ARG APP_VERSION=""
ENV TRACEAPPS_APP_VERSION=${APP_VERSION}
EXPOSE 3004
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "index.js"]
