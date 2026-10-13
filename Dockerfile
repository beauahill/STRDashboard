# Tailscale, used only when TS_AUTHKEY is set: a private route to Home Assistant (see DEPLOY.md, section 9).
FROM tailscale/tailscale:v1.98.10 AS tailscale

FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=tailscale /usr/local/bin/tailscaled /usr/local/bin/tailscale /usr/local/bin/
# The slim image has no CA bundle; Tailscale's daemon needs one to reach its servers.
COPY --from=tailscale /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY server ./server
COPY public ./public
EXPOSE 3000
CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.js"]
