FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json server.ts app.ts ./
COPY api ./api
COPY models ./models
COPY middleware ./middleware

EXPOSE 3000

CMD ["npm", "run", "dev"]
