// server.js (Versão Cloudinary)

const express = require('express');
const cors = require('cors');
const cloudinary = require('cloudinary').v2; // Importa o Cloudinary SDK
const app = express();

// --- Configuração Cloudinary ---
// As credenciais geralmente vêm de variáveis de ambiente.
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// --- Configuração Middleware ---
app.use(cors());

// Se não for mais servir estáticos locais, você pode remover:
// const path = require('path');
// app.use(express.static(path.join(__dirname, 'banners'))); 

// --- ROTA API: Retorna todos os banners do Cloudinary ---
app.get('/api/banners', async (req, res) => {
    // A tag (ou pasta) que identifica seus banners no Cloudinary
    const FOLDER_TAG = 'banners_tag'; // **Ajuste para a sua tag ou nome de pasta!**

    try {
        // Usa a API de pesquisa (search) ou lista (resources) para encontrar imagens
        // Recomenda-se usar a pesquisa com uma tag específica para melhor performance
        const result = await cloudinary.search
            .expression(`resource_type:image AND tags:${FOLDER_TAG}`)
            .max_results(30) // Limita o número de resultados
            .execute();

        const bannerUrls = result.resources
            .map(resource => resource.secure_url); // Mapeia para a URL HTTPS segura

        if (bannerUrls.length === 0) {
            console.log("Nenhum banner encontrado no Cloudinary.");
        }

        res.json({ banners: bannerUrls });
    } catch (error) {
        console.error('Erro ao carregar banners do Cloudinary:', error);
        return res.status(500).json({ error: 'Falha ao carregar banners do Cloudinary.' });
    }
});

// --- Exportação Vercel ---
module.exports = app;