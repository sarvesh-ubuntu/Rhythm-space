# syntax=docker/dockerfile:1

# ── Stage 1: build Audiveris from source ────────────────────────────────
# Audiveris doesn't ship a standalone Linux CLI download the way Windows
# gets an .msi — the supported path is building from source with Gradle
# (the project's own wrapper handles the JDK-version pinning). This stage
# only runs at `docker build` time, not per-request, so its ~5-10 min
# build cost is paid once per image build, not once per OMR call — the
# same "pay the slow cost at build/boot, not at request time" principle
# as the checkpoint-warmup fix from the ZeroGPU version of this app.
# Audiveris' Gradle build requires Java 25 to compile (its own Gradle
# config reports `theMinJavaVersion: 25` at configure time) — this is
# NOT the same as what's needed to just *run* Audiveris (that's handled
# separately by the runtime stage below, which stays on a JRE). Building
# with an older JDK here fails with "invalid source release: 25".
FROM eclipse-temurin:25-jdk-jammy AS audiveris-build


# Pin to a specific released tag rather than a moving branch, so a
# rebuild next month doesn't silently pick up a different, untested
# Audiveris version.
ARG AUDIVERIS_VERSION=5.10.2

RUN apt-get update && apt-get install -y --no-install-recommends \
        git fontconfig fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build
RUN git clone --depth 1 --branch "${AUDIVERIS_VERSION}" \
        https://github.com/Audiveris/audiveris.git .

# -x test skips the test suite, which we don't need for a build we're
# about to smoke-test ourselves at container start.
# `build` alone only produces compressed .tar/.zip archives under
# app/build/distributions/ — it does NOT unpack a runnable bin/ folder.
# `installDist` is the Gradle "application" plugin task that actually
# explodes the distribution into app/build/install/<name>/bin/<name>,
# which is what this Dockerfile needs to copy into the runtime stage.
RUN ./gradlew installDist -x test --no-daemon

# The install path has moved between Audiveris versions historically, so
# rather than hardcoding app/build/install/<name>/bin/Audiveris, find it
# once at build time and record it — the final stage copies whatever this
# resolves to.
RUN find /build -type f -name "Audiveris" -path "*/bin/*" > /tmp/audiveris_bin_path.txt \
    && test -s /tmp/audiveris_bin_path.txt || (echo "Could not locate built Audiveris launcher — check the gradle build output above for the actual install path and update this Dockerfile." && exit 1)


# ── Stage 2: runtime image ──────────────────────────────────────────────
# Must match the build stage's Java version — bytecode compiled with
# --release 25 will fail to launch (UnsupportedClassVersionError) on an
# older JRE, even though this stage never runs the Gradle build itself.
FROM eclipse-temurin:25-jre-jammy AS runtime

# poppler-utils: pdf2image's PDF->page-image backend (same role it played
# in the HF Spaces version). python3-pip: to install the small set of
# Python deps below without needing a separate Python base image.
RUN apt-get update && apt-get install -y --no-install-recommends \
        poppler-utils python3 python3-pip \
    && rm -rf /var/lib/apt/lists/* \
    && ln -sf /usr/bin/python3 /usr/bin/python

# Copy the entire resolved install directory (not just the launcher
# script) so its sibling lib/ and config/ folders come along too —
# Audiveris' launcher expects to find those next to itself.
COPY --from=audiveris-build /tmp/audiveris_bin_path.txt /tmp/audiveris_bin_path.txt
RUN mkdir -p /opt/audiveris
COPY --from=audiveris-build /build/app/build/install/ /opt/audiveris/
ENV AUDIVERIS_BIN_SEARCH_ROOT=/opt/audiveris

# Resolve the actual launcher path inside the copied tree at build time
# and bake it into an env var the app can rely on, rather than searching
# the filesystem on every container start.
RUN AUDIVERIS_BIN=$(find /opt/audiveris -type f -name "Audiveris" -path "*/bin/*" | head -n1) \
    && test -n "$AUDIVERIS_BIN" \
    && chmod +x "$AUDIVERIS_BIN" \
    && echo "$AUDIVERIS_BIN" > /opt/audiveris/BIN_PATH

WORKDIR /app
COPY requirements.txt .
RUN pip3 install --no-cache-dir -r requirements.txt

COPY app.py .

# Sanity-check the Audiveris install actually runs before we ship the
# image — fail the build loudly here rather than failing quietly on a
# user's first real request.
RUN AUDIVERIS_BIN=$(cat /opt/audiveris/BIN_PATH) \
    && "$AUDIVERIS_BIN" -help

EXPOSE 7860
# /etc/environment is NOT read by Docker's exec-form CMD, so AUDIVERIS_BIN
# has to be exported here, at container start, from the path resolved and
# baked into /opt/audiveris/BIN_PATH during the build above.
CMD ["sh", "-c", "export AUDIVERIS_BIN=$(cat /opt/audiveris/BIN_PATH) && exec python3 app.py"]