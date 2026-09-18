# ---------- 构建阶段 ----------
FROM node:20-alpine AS build
WORKDIR /app

# 先拷贝依赖清单，利用 Docker 层缓存
COPY package*.json ./
RUN npm install

# 编译 TypeScript
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---------- 运行阶段 ----------
FROM node:20-alpine
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000

COPY package*.json ./
RUN npm install --omit=dev && npm cache clean --force

# 编译产物与原生前端静态资源
COPY --from=build /app/dist ./dist
COPY public ./public

EXPOSE 3000

# 容器内以 node 用户运行
USER node

CMD ["node", "dist/server.js"]
