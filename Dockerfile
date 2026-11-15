# 古籍多版本校勘工作台 —— 纯前端静态托管镜像
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
# 容器内使用官方源即可；本机已预装 npmmirror 配置不影响镜像构建
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

FROM nginx:1.27-alpine AS runtime
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1/ >/dev/null 2>&1 || exit 1
CMD ["nginx", "-g", "daemon off;"]
