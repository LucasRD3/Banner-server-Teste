// server.js (Versão Cloudinary com Upload e Upstash Metadata)

const express = require('express');
const cors = require('cors');
const cloudinary = require('cloudinary').v2;
const multer = require('multer');
const { Redis } = require('@upstash/redis'); // <--- NOVO: Importa Upstash Redis
const app = express();

// --- Configuração Cloudinary ---
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// --- Configuração Upstash Redis ---
// Usa variáveis de ambiente padronizadas para Vercel
const redis = Redis.fromEnv(); //

// --- Configuração Middleware ---
app.use(cors());
app.use(express.json()); // <--- NOVO: Middleware para analisar corpo JSON na rota PUT

// --- Configuração Multer (Armazenamento em Memória) ---
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

const FOLDER_TAG = 'banners_tag'; 

// --- ROTA API: Upload de Banner para o Cloudinary E Armazenamento de Metadados no Upstash ---
app.post('/api/banners', upload.single('bannerImage'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'Nenhum arquivo enviado.' });
    }

    try {
        const b64 = Buffer.from(req.file.buffer).toString("base64");
        let dataURI = "data:" + req.file.mimetype + ";base64," + b64;

        // Faz o upload para o Cloudinary
        const result = await cloudinary.uploader.upload(dataURI, {
            folder: 'banners_folder', 
            tags: [FOLDER_TAG]        
        });
        
        // --- NOVO: Armazenamento de Metadados no Upstash ---
        // A chave será o public_id do Cloudinary
        const metadataKey = `banner:${result.public_id}`;
        const metadata = {
            url: result.secure_url,
            // O banner é ativo por padrão no upload
            isActive: true, 
            publicId: result.public_id
        };

        // Salva o metadado como JSON no Upstash
        await redis.set(metadataKey, JSON.stringify(metadata)); //

        console.log(`Banner ${result.public_id} enviado e metadados salvos.`);
        res.status(200).json({ 
            message: 'Upload bem-sucedido!', 
            url: result.secure_url,
            publicId: result.public_id, // Retorna o ID para gerenciamento futuro
            isActive: true
        });

    } catch (error) {
        console.error('Erro ao processar upload e metadados:', error);
        return res.status(500).json({ error: 'Falha ao fazer upload e salvar metadados.', details: error.message });
    }
});

// --- ROTA API: Retorna APENAS os banners ATIVOS do Cloudinary (Com Filtro Upstash) ---
app.get('/api/banners', async (req, res) => {
    try {
        // 1. Busca todos os recursos do Cloudinary
        const cloudinaryResult = await cloudinary.search
            .expression(`resource_type:image AND tags:${FOLDER_TAG}`)
            .max_results(30)
            .execute();

        const resources = cloudinaryResult.resources;

        if (resources.length === 0) {
            console.log("Nenhum banner encontrado no Cloudinary.");
            return res.json({ banners: [] });
        }
        
        // 2. Busca os metadados de cada banner no Upstash em paralelo
        const metadataKeys = resources.map(resource => `banner:${resource.public_id}`);
        // Usa `mget` para buscar múltiplos metadados com uma única requisição
        const metadataResults = await redis.mget(...metadataKeys);
        
        const activeBanners = [];
        
        // 3. Filtra apenas os banners que estão ativos
        resources.forEach((resource, index) => {
            const metadataString = metadataResults[index];
            if (metadataString) {
                const metadata = JSON.parse(metadataString);
                // Se o metadado existir E isActive for true, inclui o banner
                if (metadata && metadata.isActive === true) {
                    activeBanners.push({
                        url: resource.secure_url,
                        publicId: resource.public_id,
                        isActive: true
                    });
                }
            } else {
                // Caso o metadado esteja faltando (ex: banner muito antigo), você pode decidir o que fazer.
                // Aqui, vamos ignorar e registrar um erro no console.
                console.warn(`Metadados faltando para banner: ${resource.public_id}`);
            }
        });


        res.json({ banners: activeBanners });

    } catch (error) {
        console.error('Erro ao carregar banners do Cloudinary/Upstash:', error);
        return res.status(500).json({ error: 'Falha ao carregar banners (Cloudinary/Upstash).' });
    }
});

// --- NOVO: ROTA API: Ativar/Desativar Banner (Upstash) ---
app.put('/api/banners/:publicId', async (req, res) => {
    const { publicId } = req.params;
    const { isActive } = req.body; // Espera receber { "isActive": true/false }
    
    // Verifica se o campo isActive é um booleano válido
    if (typeof isActive !== 'boolean') {
        return res.status(400).json({ error: 'O corpo da requisição deve ser um JSON com o campo "isActive" booleano.' });
    }

    try {
        const metadataKey = `banner:${publicId}`;
        
        // 1. Busca o metadado existente
        const metadataString = await redis.get(metadataKey); //

        if (!metadataString) {
            return res.status(404).json({ error: `Metadados do banner com ID ${publicId} não encontrados no Upstash.` });
        }

        const metadata = JSON.parse(metadataString);
        
        // 2. Atualiza o status isActive
        metadata.isActive = isActive;
        
        // 3. Salva o metadado atualizado de volta no Upstash
        await redis.set(metadataKey, JSON.stringify(metadata)); //

        res.json({ 
            message: `Status do banner ${publicId} atualizado para isActive: ${isActive}`,
            publicId: publicId,
            isActive: isActive 
        });

    } catch (error) {
        console.error('Erro ao atualizar status do banner no Upstash:', error);
        return res.status(500).json({ error: 'Falha ao atualizar o status do banner no Upstash.', details: error.message });
    }
});


// --- Exportação Vercel ---
module.exports = app;