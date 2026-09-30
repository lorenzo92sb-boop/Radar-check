FROM node:20-bookworm

WORKDIR /app

COPY Product_Radar_Pro/Product_Radar_Pro/package.json ./

RUN npm install --omit=dev

RUN npx playwright install --with-deps chromium

COPY Product_Radar_Pro/Product_Radar_Pro/. .

ENV PORT=3000
ENV NODE_ENV=production

EXPOSE 3000

CMD ["npm", "start"]
