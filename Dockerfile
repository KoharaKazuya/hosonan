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
COPY scripts/run-generate-article.sh /opt/article-generator/scripts/run-generate-article.sh
COPY entrypoint.sh /entrypoint.sh

RUN chmod +x /opt/article-generator/scripts/run-generate-article.sh /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
