// server.js (Versão Cloudinary com Upload)

const express = require('express');
const cors = require('cors');
const cloudinary = require('cloudinary').v2;
const multer = require('multer'); // <--- NOVO: Importa Multer
const app = express();

// --- Configuração Cloudinary ---
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// --- Configuração Middleware ---
app.use(cors());

// --- Configuração Multer (Armazenamento em Memória) ---
// O Multer armazena o arquivo temporariamente na memória antes de enviá-lo ao Cloudinary.
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

// A tag que será aplicada ao banner no Cloudinary
const FOLDER_TAG = 'banners_tag'; // **Mantenha consistente com a rota GET!**

// --- ROTA API: Upload de Banner para o Cloudinary ---
app.post('/api/banners', upload.single('bannerImage'), async (req, res) => {
    // 'bannerImage' deve corresponder ao atributo `name` do campo de arquivo no HTML

    if (!req.file) {
        return res.status(400).json({ error: 'Nenhum arquivo enviado.' });
    }

    try {
        // Converte o buffer do arquivo em uma string Data URL (Base64) para o Cloudinary
        const b64 = Buffer.from(req.file.buffer).toString("base64");
        let dataURI = "data:" + req.file.mimetype + ";base64," + b64;

        // Faz o upload para o Cloudinary
        const result = await cloudinary.uploader.upload(dataURI, {
            folder: 'banners_folder', // Opcional: define uma pasta
            tags: [FOLDER_TAG]        // Aplica a tag para fácil pesquisa
        });

        console.log(`Banner ${result.public_id} enviado com sucesso.`);
        res.status(200).json({ 
            message: 'Upload bem-sucedido!', 
            url: result.secure_url 
        });

    } catch (error) {
        console.error('Erro ao fazer upload para o Cloudinary:', error);
        // Retorna erro específico para o cliente
        return res.status(500).json({ error: 'Falha ao fazer upload para o Cloudinary.', details: error.message });
    }
});

// --- ROTA API: Retorna todos os banners do Cloudinary (Mantida) ---
app.get('/api/banners', async (req, res) => {
    // ... (Código da rota GET permanece o mesmo) ...
    // Note: Em Vercel, ambas as rotas POST e GET para o mesmo endpoint são tratadas.
    
    // ... Código da rota GET original
    
    try {
        const result = await cloudinary.search
            .expression(`resource_type:image AND tags:${FOLDER_TAG}`)
            .max_results(30)
            .execute();

        const bannerUrls = result.resources
            .map(resource => resource.secure_url);

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