FROM node:24-alpine

WORKDIR /app

COPY --chown=node:node package.json package-lock.json ./
RUN chown node:node /app

USER node
RUN npm ci

EXPOSE 5173

CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0", "--port", "5173"]
