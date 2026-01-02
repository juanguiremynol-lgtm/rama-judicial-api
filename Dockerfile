# Imagen oficial de Playwright con Chromium ya incluido
FROM mcr.microsoft.com/playwright:v1.57.0-jammy

WORKDIR /app

# Copiar package.json
COPY package*.json ./

# Instalar dependencias
RUN npm install --production

# Copiar el resto del código
COPY . .

# Puerto de la app
ENV PORT=3000
EXPOSE 3000

# Iniciar la API
CMD ["npm", "start"]