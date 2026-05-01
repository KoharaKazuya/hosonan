FROM node:24-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    file \
    imagemagick \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g @openai/codex@latest

WORKDIR /opt/article-generator

COPY PROMPT.md /opt/article-generator/PROMPT.md
COPY entrypoint.sh /opt/article-generator/entrypoint.sh

RUN chmod +x /opt/article-generator/entrypoint.sh

ENTRYPOINT ["/opt/article-generator/entrypoint.sh"]
