FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY server.js auth-store.js upload-store.js push-store.js ./
COPY scripts/ scripts/
COPY public/ public/
RUN mkdir -p /app/Data/public /app/Data/private
EXPOSE 3000
CMD ["node", "server.js"]
