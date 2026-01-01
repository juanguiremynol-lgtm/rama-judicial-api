# Imagen oficial de Playwright con Chromium ya incluido
FROM mcr.microsoft.com/playwright:v1.54.1-jammy

WORKDIR /app

# Copiar package.json y package-lock.json
COPY package*.json ./

# Instalar dependencias
RUN npm ci

# Copiar el resto del código
COPY . .

# Puerto de la app
ENV PORT=3000
EXPOSE 3000

# Iniciar la API
CMD ["npm", "start"]