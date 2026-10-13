# getret.app as one image: builds the live demo (the real renderer, running on an in-browser
# demo engine) from src/renderer, then serves site/ with nginx. Build from the repo root:
#
#   docker build -f site/Dockerfile -t getret .
#   docker run --rm -p 8080:80 getret        # → http://localhost:8080

FROM node:24-bookworm-slim AS build
WORKDIR /repo
# Only the renderer's build tools are needed: skip Electron's binary and other install scripts.
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1 \
    npm_config_fund=false \
    npm_config_audit=false
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY . .
# --if-present: the site still builds (with its animated hero) if the demo script is ever missing.
RUN npm run build:demo --if-present

FROM nginx:1.29-alpine
COPY site/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/site /usr/share/nginx/html
RUN rm -f /usr/share/nginx/html/Dockerfile /usr/share/nginx/html/nginx.conf
