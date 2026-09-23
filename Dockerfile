# Reviewer build environment: Ubuntu 24.04 + Node 24, as AMO's source review
# uses. The image holds only the toolchain; the source tree is mounted, so the
# ~12 GB of build state lands next to it and an interrupted build resumes.
#
#   docker build -t browsception-build .
#   docker run --rm -v "$PWD:/src" browsception-build
#   # -> dist/browsception-<v>-{chrome.zip,firefox.xpi}
#
# Output is independent of the mount path and host (notes/distribution.md
# § Channel 3). Files the build writes are owned by the container's root.
FROM docker.io/library/ubuntu:24.04@sha256:496754492fb28b4d3049432f2ca787449331e23fb14f0dd3fffea86bf5a93eb4

ARG NODE_VERSION=24.21.0
ARG NODE_SHA256=fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6

COPY scripts/build-from-source.sh /tmp/
RUN bash /tmp/build-from-source.sh --deps-only && rm -rf /var/lib/apt/lists/* /tmp/*

RUN curl -fsSLo /tmp/node.tar.xz "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" \
    && echo "${NODE_SHA256}  /tmp/node.tar.xz" | sha256sum -c - \
    && tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 --exclude='*.md' --exclude=LICENSE \
    && rm /tmp/node.tar.xz

# The mounted tree is owned by the host user; git refuses it otherwise.
RUN git config --system --add safe.directory '*'

WORKDIR /src
CMD ["bash", "scripts/build-from-source.sh"]
