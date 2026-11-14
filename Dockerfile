# Glyphter — minimal runtime image (Alpine).
# No build stage: server.js is dependency-free Node, and the web app is static.
FROM node:alpine

WORKDIR /app

# Static app + the tiny persistence server.
COPY index.html style.css app.js font.js ./
COPY lib/ ./lib/
COPY sample/ ./sample/
COPY server.js ./
COPY MECHANICS.md mechanics.json ./

# Uploads are written here; mount a volume so they survive restarts.
VOLUME ["/app/data"]

ENV PORT=80
EXPOSE 80

CMD ["node", "server.js"]
