# One Dockerfile for all three servers, built once per server and release:
#
#   docker build -f docker/Dockerfile \
#     --build-arg PACKAGE=email-mcp --build-arg VERSION=1.1.1 docker
#
# It installs the published npm package rather than building the workspace, so
# the server is exactly the bytes npm serves for that version (with their
# provenance), and a server's image version is its npm version. Its
# dependencies are resolved at build time, as `npx` would resolve them.
FROM node:22-alpine

ARG PACKAGE
ARG VERSION

RUN set -eu; \
    case "${PACKAGE}" in \
      email-mcp|cal-mcp|card-mcp) ;; \
      *) echo "PACKAGE must be email-mcp, cal-mcp or card-mcp, got '${PACKAGE}'" >&2; exit 1 ;; \
    esac; \
    [ -n "${VERSION}" ] || { echo "VERSION is required" >&2; exit 1; }; \
    npm install --global --omit=dev --no-fund --no-audit "@miguelarios/${PACKAGE}@${VERSION}"; \
    npm cache clean --force; \
    ln -s "$(command -v "${PACKAGE}")" /usr/local/bin/pim-mcp

# An image is for running a server as a service, so it defaults to Streamable
# HTTP on port 3000. A stdio client overrides it: -e PIM_MCP_TRANSPORT=stdio.
ENV NODE_ENV=production \
    PIM_MCP_TRANSPORT=http \
    PIM_MCP_HTTP_HOST=0.0.0.0 \
    PIM_MCP_HTTP_PORT=3000

# /home/node holds cal-mcp's URL cache (~/.cache/cal-mcp); mount a volume there
# to keep it across restarts.
USER node
WORKDIR /home/node
EXPOSE 3000

# /healthz answers without touching the mail or DAV server. Over stdio there is
# no listener, so the check reports unhealthy, which `docker run --rm` ignores.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PIM_MCP_HTTP_PORT}/healthz" || exit 1

ENTRYPOINT ["pim-mcp"]
