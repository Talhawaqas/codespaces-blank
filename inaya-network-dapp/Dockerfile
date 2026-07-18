# Inaya Node Operator — one-command setup:
#   docker run -e OPERATOR_WALLET=0xYourWallet -e NODE_CAPACITY_GB=100 -v inaya-data:/app/node-data inaya-node

FROM node:18-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY src ./src

# Where persistent node identity + state lives — mount a volume here
# so the node keeps its identity and earnings across restarts.
VOLUME ["/app/node-data"]

ENV NODE_PORT=4500
ENV NODE_DATA_DIR=/app/node-data

EXPOSE 4500

CMD ["node", "src/index.js"]
