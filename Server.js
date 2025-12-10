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

// --- CHAVES ATUALIZADAS PARA SUPORTE A DIAS DA SEMANA (Usaremos um HASH) ---
// O HASH ACTIVE_BANNERS_KEY guardará: URL -> DiaDaSemana ('ALL', 'MON', 'TUE', etc.)
const ACTIVE_BANNERS_KEY = 'active_banners_with_day'; 
// DISABLED_BANNERS_KEY pode continuar sendo um SET, pois banners desativados não precisam de dia.
const DISABLED_BANNERS_KEY = 'disabled_banner_urls'; 
const CLOUDINARY_FOLDER = 'banners_folder'; 
const FOLDER_TAG = 'banners_tag'; 

// Mapeamento de Dias da Semana (0=Dom, 6=Sáb) para chaves
const DAYS_MAP = {
    0: 'SUN',
    1: 'MON',
    2: 'TUE',
    3: 'WED',
    4: 'THU',
    5: 'FRI',
    6: 'SAT',
};

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

/**
 * Retorna os banners ativos com o respectivo dia.
 * @returns {Array<{url: string, day: string}>} Lista de banners ativos.
 */
const getActiveBannersWithDay = async () => {
    const hashData = await redis.hgetall(ACTIVE_BANNERS_KEY);
    if (!hashData) return [];

    return Object.entries(hashData).map(([url, day]) => ({
        url,
        day,
    }));
};

// ------------------------------------------------------------------------
// --- 4. ROTAS ---
// ------------------------------------------------------------------------

/**
 * POST /api/banners: Upload de imagem para o Cloudinary e ativação no Redis.
 * O dia padrão de ativação será 'ALL' se não for fornecido.
 */
app.post('/api/banners', upload.single('bannerImage'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'Nenhum arquivo enviado.' });
    }
    
    // Obtém o dia do corpo da requisição (padrão para 'ALL')
    const day = req.body.day ? req.body.day.toUpperCase() : 'ALL';
    const validDays = [...Object.values(DAYS_MAP), 'ALL'];

    if (!validDays.includes(day)) {
        return res.status(400).json({ error: `Dia inválido. Use: ${validDays.join(', ')}` });
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

        // 2. Adiciona a URL e o Dia ao HASH de banners ativos no Redis
        await redis.hset(ACTIVE_BANNERS_KEY, { [bannerUrl]: day });

        console.log(`✅ Banner ${result.public_id} enviado e URL adicionada ao Redis com dia: ${day}.`);
        res.status(201).json({ // 201 Created é mais adequado para POST de criação
            message: 'Upload bem-sucedido e banner ativado!', 
            url: bannerUrl,
            day: day
        });

    } catch (error) {
        console.error('❌ Erro ao processar upload:', error);
        return res.status(500).json({ error: 'Falha ao fazer upload.', details: error.message });
    }
});

/**
 * GET /api/banners: Lista todos os banners ATIVOS *PARA O DIA ATUAL*.
 */
app.get('/api/banners', async (req, res) => {
    try {
        const today = new Date().getDay(); // 0=Dom, 1=Seg, ..., 6=Sáb
        const todayKey = DAYS_MAP[today]; // 'SUN', 'MON', etc.
        
        // Obtém todas as URLs ativas e seus respectivos dias
        const activeBanners = await getActiveBannersWithDay();

        // Filtra banners que são 'ALL' ou correspondem ao dia de hoje
        const filteredUrls = activeBanners
            .filter(banner => banner.day === 'ALL' || banner.day === todayKey)
            .map(banner => banner.url);
        
        if (filteredUrls.length === 0) {
            console.log("ℹ️ Nenhum banner ativo encontrado para o dia de hoje.");
        }

        // Retorna apenas a lista de URLs
        res.json({ banners: filteredUrls, day: todayKey });
        
    } catch (error) {
        console.error('❌ Erro ao carregar banners ativos do Redis:', error);
        return res.status(500).json({ error: 'Falha ao carregar banners ativos.' });
    }
});

/**
 * GET /api/banners/all: Lista todos os banners ATIVOS *com a regra de dia*. (Para o Dashboard)
 */
app.get('/api/banners/all', async (req, res) => {
    try {
        const activeBanners = await getActiveBannersWithDay();
        if (activeBanners.length === 0) {
            console.log("ℹ️ Nenhum banner ativo encontrado.");
        }
        // Retorna a lista de objetos {url, day}
        res.json({ banners: activeBanners });
        
    } catch (error) {
        console.error('❌ Erro ao carregar todos os banners ativos do Redis:', error);
        return res.status(500).json({ error: 'Falha ao carregar todos os banners ativos.' });
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
        // 1. Remove do HASH de ativos
        const removedFromActive = await redis.hdel(ACTIVE_BANNERS_KEY, url);

        if (removedFromActive === 0) {
            // Se não estava no ativo, tenta remover do desativado para garantir que não está em nenhum lugar antes de falhar
            const wasAlreadyDisabled = await redis.sismember(DISABLED_BANNERS_KEY, url);
            if(wasAlreadyDisabled) {
                 return res.status(404).json({ error: 'Banner já está na lista de desativados.' });
            }
            return res.status(404).json({ error: 'Banner não encontrado na lista de ativos.' });
        }

        // 2. Adiciona ao SET de desativados
        await redis.sadd(DISABLED_BANNERS_KEY, url);

        console.log(`✔️ Banner desativado: ${url}`);
        return res.json({ message: 'Banner desativado com sucesso.', url });

    } catch (error) {
        console.error('❌ Erro ao desativar banner no Redis:', error);
        return res.status(500).json({ error: 'Falha ao desativar banner.' });
    }
});


/**
 * PUT /api/banners/enable: Move um banner de desativado para ativo no Redis, definindo o dia.
 */
app.put('/api/banners/enable', async (req, res) => {
    const { url, day } = req.body;
    
    // Dia padrão é 'ALL' se não for fornecido
    const targetDay = day ? day.toUpperCase() : 'ALL';
    const validDays = [...Object.values(DAYS_MAP), 'ALL'];

    if (!url || !validDays.includes(targetDay)) {
        return res.status(400).json({ error: 'A URL do banner é obrigatória e o dia deve ser válido.' });
    }

    try {
        // 1. Remove do SET de desativados
        const removedFromDisabled = await redis.srem(DISABLED_BANNERS_KEY, url);

        if (removedFromDisabled === 0) {
            // Se não estava no desativado, verifica se já está no ativo para evitar duplicação e notificar
            const wasAlreadyActive = await redis.hget(ACTIVE_BANNERS_KEY, url);
            if (wasAlreadyActive) {
                return res.status(404).json({ error: 'Banner já está ativo.' });
            }
            return res.status(404).json({ error: 'Banner não encontrado na lista de desativados.' });
        }

        // 2. Adiciona ao HASH de ativos com a nova regra de dia
        await redis.hset(ACTIVE_BANNERS_KEY, { [url]: targetDay });

        console.log(`✔️ Banner reativado: ${url} para o dia: ${targetDay}`);
        return res.json({ message: 'Banner reativado com sucesso.', url, day: targetDay });

    } catch (error) {
        console.error('❌ Erro ao reativar banner no Redis:', error);
        return res.status(500).json({ error: 'Falha ao reativar banner.' });
    }
});

/**
 * PUT /api/banners/update-day: Atualiza o dia de exibição de um banner ATIVO.
 */
app.put('/api/banners/update-day', async (req, res) => {
    const { url, day } = req.body;
    
    const targetDay = day ? day.toUpperCase() : 'ALL';
    const validDays = [...Object.values(DAYS_MAP), 'ALL'];

    if (!url || !validDays.includes(targetDay)) {
        return res.status(400).json({ error: 'A URL do banner é obrigatória e o dia deve ser válido.' });
    }
    
    try {
        // 1. Verifica se o banner existe no HASH de ativos
        const currentDay = await redis.hget(ACTIVE_BANNERS_KEY, url);

        if (!currentDay) {
            return res.status(404).json({ error: 'Banner não encontrado na lista de ativos.' });
        }

        // 2. Atualiza o valor no HASH de ativos
        await redis.hset(ACTIVE_BANNERS_KEY, { [url]: targetDay });

        console.log(`🔄 Dia do Banner atualizado: ${url} para ${targetDay}.`);
        return res.json({ message: 'Dia de exibição atualizado com sucesso.', url, day: targetDay });

    } catch (error) {
        console.error('❌ Erro ao atualizar o dia do banner no Redis:', error);
        return res.status(500).json({ error: 'Falha ao atualizar o dia do banner.' });
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
        // 1. Tenta remover a URL dos dois locais do Redis (Hash e Set)
        const removedActive = await redis.hdel(ACTIVE_BANNERS_KEY, url);
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