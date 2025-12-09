// server.js (Versão Limpa e Otimizada com Cloudinary e Upstash Redis)

const express = require('express');
const cors = require('cors');
const cloudinary = require('cloudinary').v2;
const multer = require('multer');
const { Redis } = require('@upstash/redis');

const app = express();

// ------------------------------------------------------------------------
// --- 1. CONFIGURAÇÃO DE SERVIÇOS E VARIÁVEIS GLOBAIS ---
// ------------------------------------------------------------------------

// Configuração Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// Configuração Upstash (Redis)
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const ACTIVE_BANNERS_KEY = 'active_banner_urls'; 
const DISABLED_BANNERS_KEY = 'disabled_banner_urls'; 
const CLOUDINARY_FOLDER = 'banners_folder'; 
const FOLDER_TAG = 'banners_tag'; 

// ------------------------------------------------------------------------
// --- 2. MIDDLEWARES ---
// ------------------------------------------------------------------------

app.use(cors());
app.use(express.json()); 

// Configuração Multer (Armazenamento em Memória)
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

// ------------------------------------------------------------------------
// --- 3. FUNÇÕES AUXILIARES (UTILITIES) ---
// ------------------------------------------------------------------------

/**
 * Extrai o 'public_id' completo (com a pasta) da URL do Cloudinary.
 * Ex: 'banners_folder/public_id_aqui'
 * @param {string} url - A URL completa do banner.
 * @returns {string | null} O public_id ou null em caso de falha.
 */
const extractPublicIdFromUrl = (url) => {
    try {
        // Exemplo: https://res.cloudinary.com/dvxxxxxx/image/upload/v1700000000/banners_folder/public_id_aqui.png
        const parts = url.split('/');
        
        // Verifica se a URL tem o formato esperado
        if (parts.length < 2) return null;
        
        // O nome do arquivo é o último item (excluindo a extensão)
        const fileNameWithExt = parts[parts.length - 1];
        const fileName = fileNameWithExt.substring(0, fileNameWithExt.lastIndexOf('.'));
        
        // O nome da pasta é o penúltimo item, garantindo que seja o folder que definimos
        const folderName = parts[parts.length - 2]; 
        
        if (folderName !== CLOUDINARY_FOLDER) return null;

        return `${folderName}/${fileName}`;

    } catch (e) {
        console.error('Erro ao extrair public_id:', e);
        return null;
    }
};

// ------------------------------------------------------------------------
// --- 4. ROTAS ---
// ------------------------------------------------------------------------

/**
 * POST /api/banners: Upload de imagem para o Cloudinary e ativação no Redis.
 */
app.post('/api/banners', upload.single('bannerImage'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'Nenhum arquivo enviado.' });
    }

    try {
        const b64 = Buffer.from(req.file.buffer).toString("base64");
        const dataURI = `data:${req.file.mimetype};base64,${b64}`;

        // 1. Upload para o Cloudinary
        const result = await cloudinary.uploader.upload(dataURI, {
            folder: CLOUDINARY_FOLDER, 
            tags: [FOLDER_TAG]        
        });
        
        const bannerUrl = result.secure_url;

        // 2. Adiciona a URL ao conjunto de banners ativos no Redis
        await redis.sadd(ACTIVE_BANNERS_KEY, bannerUrl);

        console.log(`✅ Banner ${result.public_id} enviado e URL adicionada ao Redis.`);
        res.status(201).json({ // 201 Created é mais adequado para POST de criação
            message: 'Upload bem-sucedido e banner ativado!', 
            url: bannerUrl 
        });

    } catch (error) {
        console.error('❌ Erro ao processar upload:', error);
        return res.status(500).json({ error: 'Falha ao fazer upload.', details: error.message });
    }
});

/**
 * GET /api/banners: Lista todos os banners ATIVOS.
 */
app.get('/api/banners', async (req, res) => {
    try {
        const activeUrls = await redis.smembers(ACTIVE_BANNERS_KEY);
        if (activeUrls.length === 0) {
            console.log("ℹ️ Nenhum banner ativo encontrado.");
        }
        res.json({ banners: activeUrls });
        
    } catch (error) {
        console.error('❌ Erro ao carregar banners ativos do Redis:', error);
        return res.status(500).json({ error: 'Falha ao carregar banners ativos.' });
    }
});

/**
 * GET /api/banners/disabled: Lista todos os banners DESATIVADOS.
 */
app.get('/api/banners/disabled', async (req, res) => {
    try {
        const disabledUrls = await redis.smembers(DISABLED_BANNERS_KEY);
        if (disabledUrls.length === 0) {
            console.log("ℹ️ Nenhum banner desativado encontrado.");
        }
        res.json({ banners: disabledUrls });
        
    } catch (error) {
        console.error('❌ Erro ao carregar banners desativados do Redis:', error);
        return res.status(500).json({ error: 'Falha ao carregar banners desativados.' });
    }
});

/**
 * PUT /api/banners/disable: Move um banner de ativo para desativado no Redis.
 */
app.put('/api/banners/disable', async (req, res) => {
    const { url } = req.body; 

    if (!url) {
        return res.status(400).json({ error: 'A URL do banner é obrigatória.' });
    }

    try {
        // SMOVE move o elemento de ACTIVE_BANNERS para DISABLED_BANNERS
        const moved = await redis.smove(ACTIVE_BANNERS_KEY, DISABLED_BANNERS_KEY, url);

        if (moved === 1) {
            console.log(`✔️ Banner desativado: ${url}`);
            return res.json({ message: 'Banner desativado com sucesso.', url });
        } else {
            return res.status(404).json({ error: 'Banner não encontrado na lista de ativos. (Já desativado ou URL incorreta)' });
        }

    } catch (error) {
        console.error('❌ Erro ao desativar banner no Redis:', error);
        return res.status(500).json({ error: 'Falha ao desativar banner.' });
    }
});

/**
 * PUT /api/banners/enable: Move um banner de desativado para ativo no Redis.
 */
app.put('/api/banners/enable', async (req, res) => {
    const { url } = req.body;

    if (!url) {
        return res.status(400).json({ error: 'A URL do banner é obrigatória.' });
    }

    try {
        // SMOVE move o elemento de DISABLED_BANNERS para ACTIVE_BANNERS
        const moved = await redis.smove(DISABLED_BANNERS_KEY, ACTIVE_BANNERS_KEY, url);

        if (moved === 1) {
            console.log(`✔️ Banner reativado: ${url}`);
            return res.json({ message: 'Banner reativado com sucesso.', url });
        } else {
            return res.status(404).json({ error: 'Banner não encontrado na lista de desativados.' });
        }

    } catch (error) {
        console.error('❌ Erro ao reativar banner no Redis:', error);
        return res.status(500).json({ error: 'Falha ao reativar banner.' });
    }
});

/**
 * DELETE /api/banners: Exclui permanentemente o banner do Redis e Cloudinary.
 */
app.delete('/api/banners', async (req, res) => {
    const { url } = req.body;

    if (!url) {
        return res.status(400).json({ error: 'A URL do banner é obrigatória para a exclusão.' });
    }

    try {
        // 1. Tenta remover a URL dos dois conjuntos do Redis
        const removedActive = await redis.srem(ACTIVE_BANNERS_KEY, url);
        const removedDisabled = await redis.srem(DISABLED_BANNERS_KEY, url);
        const redisRemoved = removedActive + removedDisabled;

        if (redisRemoved === 0) {
            // Se não foi removido de nenhum lugar, a URL não existe
            return res.status(404).json({ error: 'Banner não encontrado nos registros do Redis.' });
        }

        // 2. Extrai o public_id da URL do Cloudinary
        const publicId = extractPublicIdFromUrl(url);

        if (!publicId) {
             console.error(`⚠️ Falha ao extrair public_id de: ${url}. Apenas remoção do Redis realizada.`);
             return res.status(200).json({ message: 'Banner removido do Redis, mas falhou ao extrair o ID para exclusão no Cloudinary.', url, redisRemoved });
        }

        // 3. Deleta do Cloudinary
        const destroyResult = await cloudinary.uploader.destroy(publicId); 
        
        let cloudinaryStatus = destroyResult.result;
        
        if (cloudinaryStatus === 'not found') {
             console.warn(`⚠️ Cloudinary: Arquivo ${publicId} não encontrado na nuvem, mas removido do Redis.`);
             cloudinaryStatus = 'removed_from_redis_only (file_not_found_on_cloud)';
        } else if (cloudinaryStatus !== 'ok') {
            console.error('❌ Erro ao deletar no Cloudinary:', destroyResult);
            // Retorna sucesso para o Redis mas notifica o problema no Cloudinary
            return res.status(200).json({ message: 'Banner removido do Redis, mas houve um erro na exclusão do Cloudinary.', url, cloudinaryStatus });
        }


        console.log(`🔥 Banner EXCLUÍDO permanentemente: ${url}`);
        return res.json({ message: 'Banner excluído com sucesso.', url, redisRemoved, cloudinaryStatus: 'ok' });

    } catch (error) {
        console.error('❌ Erro ao excluir banner:', error);
        return res.status(500).json({ error: 'Falha ao excluir banner.' });
    }
});


// ------------------------------------------------------------------------
// --- 5. EXPORTAÇÃO VERCEL ---
// ------------------------------------------------------------------------
module.exports = app;