# Vibes 3D Studio — headless slicing quote service
#
# THIS IMAGE RUNS BAMBU STUDIO, ON PURPOSE.
#
# Not because other slicers are inaccurate. Measured against Bambu Studio on
# identical input, OrcaSlicer agrees to within about 1% — the one model that
# looked like a 21% outlier turned out to be a modified infill setting in the
# GUI, not a difference between the programs.
#
# The reason is that the quote has to be *the* number, not a number close to
# it. Same binary, same version, same presets means there is nothing left to
# drift: no second engine to re-validate after every update, and no argument
# with a customer about whose slicer was right. OrcaSlicer stays as the
# development fallback so the app runs on a machine with nothing installed.
#
# Bambu Studio ships for Linux as an AppImage. AppImages normally need FUSE,
# which is awkward inside a container, so we extract it at build time and run
# the extracted AppRun directly. It is still a GTK app underneath even in CLI
# mode, so xvfb provides a virtual display.
#
# BUILD
#   docker build -t vibes-quote .
#
# The pinned release below is the one the profiles were built and verified
# against. Override it deliberately, never incidentally:
#   docker build --build-arg BAMBU_STUDIO_URL=<url> --build-arg BAMBU_STUDIO_SHA256=<sha> .
#
# Bambu Studio is AGPLv3. Fetching it at build time from the official release
# keeps this Dockerfile something you can publish; the image you build from it
# contains Bambu Studio, so keep that image private. See "Cloud hosting" in
# ../README.md for host requirements.

FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

# --- system deps -------------------------------------------------------------
# The GTK/webkit/mesa packages are what the AppImage links against; without
# them the binary exits immediately with a loader error rather than a useful
# message.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl xz-utils file \
      xvfb libgtk-3-0 libwebkit2gtk-4.1-0 libsoup-3.0-0 \
      libgl1 libopengl0 libglu1-mesa libegl1 libgbm1 libosmesa6 \
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

# --- slicing engine ----------------------------------------------------------
# Bambu Studio, from the official Linux AppImage release, pinned by version and
# verified by checksum. Pinned rather than tracking latest because a slicer
# update can move the numbers, and a quote that changes because an image was
# rebuilt is a bug nobody would think to look for. The checksum matters because
# the next instruction runs this binary.
ARG BAMBU_STUDIO_VERSION=v02.08.02.61
ARG BAMBU_STUDIO_URL=https://github.com/bambulab/BambuStudio/releases/download/v02.08.02.61/BambuStudio_ubuntu22.04-v02.08.02.61-20260820225108.AppImage
ARG BAMBU_STUDIO_SHA256=69426a59682574591590f51c913d3889baa19252d1c8e9fcae2497eb0ed6bf92
RUN set -eux; \
    curl -fSL "$BAMBU_STUDIO_URL" -o /tmp/bambu.AppImage; \
    echo "${BAMBU_STUDIO_SHA256}  /tmp/bambu.AppImage" | sha256sum -c -; \
    chmod +x /tmp/bambu.AppImage; \
    cd /opt; \
    /tmp/bambu.AppImage --appimage-extract > /dev/null; \
    mv /opt/squashfs-root /opt/bambu-studio; \
    rm /tmp/bambu.AppImage; \
    test -x /opt/bambu-studio/AppRun

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
    SLICER_ENGINE=bambu \
    REQUIRE_ENGINE=bambu \
    PROFILE_DIR=/app/profiles \
    SLICE_TIMEOUT_MS=180000 \
    MAX_CONCURRENT_SLICES=2

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
  CMD curl -fsS http://localhost:8080/api/health || exit 1

CMD ["node", "src/index.js"]
