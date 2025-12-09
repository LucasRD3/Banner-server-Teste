// server.js (Versão Cloudinary + Upstash Redis)

const express = require('express');
const cors = require('cors');
const cloudinary = require('cloudinary').v2;
const multer = require('multer');
const { Redis } = require('@upstash/redis'); // Importa Upstash Redis
const app = express();

// --- Configuração Cloudinary ---
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// --- Configuração Upstash (Redis) ---
// Configuração que utiliza as variáveis de ambiente
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// Chaves que armazenarão as URLs dos banners no Redis
const ACTIVE_BANNERS_KEY = 'active_banner_urls'; 
const DISABLED_BANNERS_KEY = 'disabled_banner_urls'; 

// --- Configuração Middleware ---
app.use(cors());
// Novo: Habilita o Express a processar o corpo da requisição em JSON (necessário para a rota PUT)
app.use(express.json());

// --- Configuração Multer (Armazenamento em Memória) ---
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

const FOLDER_TAG = 'banners_tag'; 

// --- ROTA API: Upload de Banner (Adiciona ao Cloudinary e ao Redis Ativo) ---
app.post('/api/banners', upload.single('bannerImage'), async (req, res) => {

    if (!req.file) {
        return res.status(400).json({ error: 'Nenhum arquivo enviado.' });
    }

    try {
        const b64 = Buffer.from(req.file.buffer).toString("base64");
        let dataURI = "data:" + req.file.mimetype + ";base64," + b64;

        // 1. Upload para o Cloudinary
        const result = await cloudinary.uploader.upload(dataURI, {
            folder: 'banners_folder', 
            tags: [FOLDER_TAG]        
        });
        
        const bannerUrl = result.secure_url;

        // 2. Adiciona a URL ao conjunto de banners ativos no Redis
        await redis.sadd(ACTIVE_BANNERS_KEY, bannerUrl);

        console.log(`Banner ${result.public_id} enviado e URL adicionada ao Redis.`);
        res.status(200).json({ 
            message: 'Upload bem-sucedido!', 
            url: bannerUrl 
        });

    } catch (error) {
        console.error('Erro ao fazer upload para o Cloudinary ou Redis:', error);
        return res.status(500).json({ error: 'Falha ao fazer upload.' });
    }
});


// --- NOVA ROTA API: Desativar Banner (Remove do Ativo e move para o Desativado) ---
app.put('/api/banners/disable', async (req, res) => {
    // Espera-se que o corpo da requisição contenha a 'url' do banner
    const { url } = req.body; 

    if (!url) {
        return res.status(400).json({ error: 'A URL do banner é obrigatória no corpo da requisição.' });
    }

    try {
        // Usa SMOVE do Redis: move a URL do conjunto ACTIVE para o DISABLED
        const moved = await redis.smove(ACTIVE_BANNERS_KEY, DISABLED_BANNERS_KEY, url);

        if (moved === 1) {
            // Se moved for 1, a URL foi movida com sucesso
            console.log(`Banner desativado: ${url}`);
            return res.json({ message: 'Banner desativado com sucesso.', url });
        } else {
            // Se moved for 0, a URL não estava no conjunto de ativos
            return res.status(404).json({ error: 'Banner não encontrado na lista de ativos. (Já desativado ou URL incorreta)' });
        }

    } catch (error) {
        console.error('Erro ao desativar banner no Redis:', error);
        return res.status(500).json({ error: 'Falha ao desativar banner.' });
    }
});


// --- ROTA API: Retorna todos os banners ATIVOS (Consultando Apenas o Redis) ---
app.get('/api/banners', async (req, res) => {
    
    try {
        // Pega todos os membros do conjunto de banners ativos no Redis (operação muito rápida)
        const activeUrls = await redis.smembers(ACTIVE_BANNERS_KEY);

        if (activeUrls.length === 0) {
            console.log("Nenhum banner ativo encontrado no Redis.");
        }

        // Retorna o array de URLs ativas
        res.json({ banners: activeUrls });
        
    } catch (error) {
        console.error('Erro ao carregar banners do Redis:', error);
        // Em caso de falha, retorna um erro 500
        return res.status(500).json({ error: 'Falha ao carregar banners do Redis.' });
    }
});


// --- Exportação Vercel ---
module.exports = app;