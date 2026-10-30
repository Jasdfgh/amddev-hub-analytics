# Node 24 official image, pinned to a verified public multi-platform digest.
FROM public.ecr.aws/docker/library/node@sha256:e67514e5d0f6c46656005e1b693b2ec9d52e80b641307de684d4a015ba7a4eaf AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund

FROM public.ecr.aws/docker/library/node@sha256:e67514e5d0f6c46656005e1b693b2ec9d52e80b641307de684d4a015ba7a4eaf AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080 DATA_MODE=demo
WORKDIR /app
COPY --from=dependencies --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json package-lock.json LICENSE ./
COPY --chown=node:node public/ ./public/
COPY --chown=node:node server/ ./server/
COPY --chown=node:node shared/catalog.json shared/catalog-rules.json shared/link-map.mjs ./shared/
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/index.mjs"]
