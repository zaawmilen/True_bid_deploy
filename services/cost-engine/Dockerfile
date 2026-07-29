# ---- build stage: compile TypeScript ----
FROM node:20-slim AS build
WORKDIR /app
COPY package.json tsconfig.json ./
RUN npm install
COPY src ./src
RUN npm run build

# ---- runtime stage: production deps + compiled JS only ----
FROM node:20-slim
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY --from=build /app/dist ./dist
EXPOSE 8000
CMD ["node", "--require", "./dist/bootstrap.js", "dist/index.js"]
