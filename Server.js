// server.js (Versão Cloudinary com Upload e Upstash)

const express = require('express');
const cors = require('cors');
const cloudinary = require('cloudinary').v2;
const multer = require('multer');
const { Redis } = require('@upstash/redis'); // Importa Upstash

const app = express();

// --- Configuração Middleware ---
app.use(cors());
// Middleware para analisar JSON no corpo das requisições (necessário para a rota PUT de status)
app.use(express.json()); 

// --- Configuração Cloudinary ---
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// --- Configuração Upstash Redis ---
// A URL e o Token são lidos automaticamente do process.env no ambiente Vercel
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// --- Configuração Multer (Armazenamento em Memória) ---
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

// A tag que será aplicada ao banner no Cloudinary (Mantida para consistência, mas o filtro será via Upstash)
const FOLDER_TAG = 'banners_tag';
const REDIS_KEY_PREFIX = 'banner:'; // Prefixo para as chaves no Redis

// --- ROTA API: Upload de Banner para o Cloudinary e Salva Metadado no Upstash ---
app.post('/api/banners', upload.single('bannerImage'), async (req, res) => {
    // 'bannerImage' deve corresponder ao atributo `name` do campo de arquivo no HTML

    if (!req.file) {
        return res.status(400).json({ error: 'Nenhum arquivo enviado.' });
    }

    try {
        // 1. Upload para Cloudinary
        const b64 = Buffer.from(req.file.buffer).toString("base64");
        let dataURI = "data:" + req.file.mimetype + ";base64," + b64;

        const result = await cloudinary.uploader.upload(dataURI, {
            folder: 'banners_folder',
            tags: [FOLDER_TAG]
        });

        // 2. Salva Metadados no Upstash Redis
        const bannerId = result.public_id; // Usa o public_id do Cloudinary como ID única
        const bannerKey = REDIS_KEY_PREFIX + bannerId;

        const metadata = {
            id: bannerId,
            url: result.secure_url,
            // Status 'ativo' por padrão
            status: 'ativo', 
            uploadedAt: new Date().toISOString()
        };

        // Salva o objeto de metadados no Redis como um Hash (HSET)
        await redis.hset(bannerKey, metadata);
        
        console.log(`Banner ${bannerId} enviado e metadados salvos no Upstash.`);
        res.status(200).json({ 
            message: 'Upload bem-sucedido!', 
            url: result.secure_url,
            bannerId: bannerId 
        });

    } catch (error) {
        console.error('Erro no processamento de upload e metadados:', error);
        return res.status(500).json({ error: 'Falha no processamento do banner.', details: error.message });
    }
});

// --- ROTA API: Retorna banners ativos do Upstash (Filtro por Status) ---
app.get('/api/banners', async (req, res) => {
    try {
        // 1. Encontra todas as chaves de banner (ex: 'banner:public_id_1')
        const allKeys = await redis.keys(REDIS_KEY_PREFIX + '*');
        
        if (allKeys.length === 0) {
            return res.json({ banners: [] });
        }

        // 2. Busca os metadados para todas as chaves (HGETALL)
        // O HGETALL retorna um objeto, mas como o Upstash client faz a desserialização,
        // ele retorna os campos como um objeto JS.
        const metadataPromises = allKeys.map(key => redis.hgetall(key));
        const allMetadata = await Promise.all(metadataPromises);

        // 3. Filtra apenas os banners com status 'ativo'
        const activeBanners = allMetadata.filter(metadata => metadata && metadata.status === 'ativo');

        // 4. Extrai as URLs
        const bannerUrls = activeBanners.map(metadata => metadata.url);

        if (bannerUrls.length === 0) {
            console.log("Nenhum banner ativo encontrado.");
        }

        res.json({ banners: bannerUrls });
        
    } catch (error) {
        console.error('Erro ao carregar banners do Upstash:', error);
        return res.status(500).json({ error: 'Falha ao carregar banners.' });
    }
});

// --- ROTA API: Altera o status de um banner (Pausa/Ativa) ---
// Requisição: PUT /api/banners/public_id_do_banner/status
// Body (JSON): { "status": "pausado" } ou { "status": "ativo" }
app.put('/api/banners/:id/status', async (req, res) => {
    const bannerId = req.params.id;
    const newStatus = req.body.status; // Deve ser 'ativo' ou 'pausado'
    const bannerKey = REDIS_KEY_PREFIX + bannerId;

    if (newStatus !== 'ativo' && newStatus !== 'pausado') {
        return res.status(400).json({ error: "Status inválido. Use 'ativo' ou 'pausado'." });
    }

    try {
        // Verifica se a chave do banner existe
        const exists = await redis.exists(bannerKey);
        if (!exists) {
            return res.status(404).json({ error: `Banner com ID ${bannerId} não encontrado no Upstash.` });
        }

        // Atualiza apenas o campo 'status' no Hash do Redis
        await redis.hset(bannerKey, { status: newStatus });

        console.log(`Status do banner ${bannerId} atualizado para: ${newStatus}`);
        res.status(200).json({ 
            message: `Status do banner ${bannerId} atualizado para ${newStatus}.` 
        });

    } catch (error) {
        console.error('Erro ao atualizar status do banner no Upstash:', error);
        return res.status(500).json({ error: 'Falha ao atualizar o status do banner.', details: error.message });
    }
});

// --- Exportação Vercel ---
module.exports = app;