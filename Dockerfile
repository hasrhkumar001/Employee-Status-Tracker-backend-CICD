

# Production Stage
FROM node:22 as prod

WORKDIR /app

COPY backend/package*.json ./

RUN npm install 

COPY backend ./

CMD ["node", "index.js"]