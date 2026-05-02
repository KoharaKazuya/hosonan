FROM node:24-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    file \
    git \
    imagemagick \
    ripgrep \
    tzdata \
    webp \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g @openai/codex@latest

WORKDIR /opt/hosonan

COPY PROMPT.md /opt/hosonan/PROMPT.md
COPY entrypoint.sh /opt/hosonan/entrypoint.sh

RUN chmod +x /opt/hosonan/entrypoint.sh

ENTRYPOINT ["/opt/hosonan/entrypoint.sh"]
