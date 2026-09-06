# Vibes 3D Studio — headless slicing quote service
#
# Bambu Studio ships for Linux as an AppImage. AppImages normally need FUSE,
# which is awkward inside a container, so we extract it at build time and run
# the extracted AppRun directly. It is still a GTK app underneath even in CLI
# mode, so xvfb provides a virtual display.

FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

# --- system deps -------------------------------------------------------------
# The GTK/webkit/mesa packages are what the AppImage links against; without
# them the binary exits immediately with a loader error rather than a useful
# message.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl xz-utils file \
      xvfb libgtk-3-0 libwebkit2gtk-4.1-0 libsoup-3.0-0 \
      libgl1 libglu1-mesa libegl1 libgbm1 libosmesa6 \
      libglib2.0-0 libnss3 libxss1 libasound2t64 \
      libsecret-1-0 libgstreamer1.0-0 libgstreamer-plugins-base1.0-0 \
      locales \
  && locale-gen en_US.UTF-8 \
  && rm -rf /var/lib/apt/lists/*

ENV LANG=en_US.UTF-8

# --- node --------------------------------------------------------------------
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
  && apt-get install -y --no-install-recommends nodejs \
  && rm -rf /var/lib/apt/lists/*

# --- Bambu Studio ------------------------------------------------------------
# Pin a specific release. Check https://github.com/bambulab/BambuStudio/releases
# for the current Linux AppImage asset and override at build time:
#   docker build --build-arg BAMBU_URL="https://github.com/.../Bambu_Studio_....AppImage" .
ARG BAMBU_URL=""
RUN set -eux; \
    if [ -z "$BAMBU_URL" ]; then \
      echo "ERROR: BAMBU_URL build arg is required."; \
      echo "Find the Linux .AppImage asset at https://github.com/bambulab/BambuStudio/releases"; \
      echo "then rebuild with --build-arg BAMBU_URL=<url>"; \
      exit 1; \
    fi; \
    curl -fSL "$BAMBU_URL" -o /tmp/bambu.AppImage; \
    chmod +x /tmp/bambu.AppImage; \
    cd /opt; \
    /tmp/bambu.AppImage --appimage-extract > /dev/null; \
    mv /opt/squashfs-root /opt/bambu-studio; \
    rm /tmp/bambu.AppImage; \
    ls /opt/bambu-studio/AppRun

# Wrapper so `bambu-studio` works as a normal command, with the virtual
# display already attached.
RUN printf '#!/bin/sh\nexec xvfb-run -a --server-args="-screen 0 1280x1024x24" /opt/bambu-studio/AppRun "$@"\n' \
      > /usr/local/bin/bambu-studio \
  && chmod +x /usr/local/bin/bambu-studio

# --- app ---------------------------------------------------------------------
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev

COPY src ./src
COPY profiles ./profiles

# Slicing writes scratch files; keep them on a tmpfs-friendly path.
ENV NODE_ENV=production \
    PORT=8080 \
    BAMBU_STUDIO_BIN=bambu-studio \
    PROFILE_DIR=/app/profiles \
    SLICE_TIMEOUT_MS=180000 \
    MAX_CONCURRENT_SLICES=2

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
  CMD curl -fsS http://localhost:8080/api/health || exit 1

CMD ["node", "src/index.js"]
