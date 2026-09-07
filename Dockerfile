FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY server.js .
COPY upload-store.js .
COPY push-store.js .
COPY public/ public/
RUN mkdir -p /app/Data/public /app/Data/private
EXPOSE 3000
CMD ["node", "server.js"]
