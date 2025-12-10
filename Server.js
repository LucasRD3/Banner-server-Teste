// server.js (Versão com Prioridade)

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

// --- CHAVES ATUALIZADAS ---
// O HASH ACTIVE_BANNERS_KEY guardará: URL -> DiaDaSemana ('ALL', 'MON', 'TUE', etc.)
const ACTIVE_BANNERS_KEY = 'active_banners_with_day'; 
// DISABLED_BANNERS_KEY continua sendo um SET.
const DISABLED_BANNERS_KEY = 'disabled_banner_urls'; 
// NOVO: Sorted Set (ZSET) para armazenar a PRIORIDADE (Score) -> URL (Member)
const PRIORITY_BANNERS_KEY = 'priority_banners_zset'; 
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
        const parts = url.split('/');
        
        if (parts.length < 2) return null;
        
        const fileNameWithExt = parts[parts.length - 1];
        const fileName = fileNameWithExt.substring(0, fileNameWithExt.lastIndexOf('.'));
        
        const folderName = parts[parts.length - 2]; 
        
        if (folderName !== CLOUDINARY_FOLDER) return null;

        return `${folderName}/${fileName}`;

    } catch (e) {
        console.error('Erro ao extrair public_id:', e);
        return null;
    }
};

/**
 * Retorna os banners ativos com o respectivo dia E prioridade.
 * @returns {Array<{url: string, day: string, priority: number}>} Lista de banners ativos.
 */
const getActiveBannersWithDay = async () => {
    // 1. Pega dados do HASH (URL -> DAY)
    const hashData = await redis.hgetall(ACTIVE_BANNERS_KEY);
    if (!hashData) return [];

    // 2. Pega todos os dados do ZSET (URL e PRIORIDADE)
    // ZRANGE com WITHSCORES retorna uma lista plana de [member, score, member, score, ...]
    // Pega do menor score (0) ao maior (-1)
    const zsetMembers = await redis.zrange(PRIORITY_BANNERS_KEY, 0, -1, { withScores: true });

    const zsetMap = new Map();
    // Converte a lista plana em um Map { url: priority }
    for (let i = 0; i < zsetMembers.length; i += 2) {
        zsetMap.set(zsetMembers[i], zsetMembers[i + 1]);
    }

    // 3. Combina HASH e ZSET
    const combinedBanners = Object.entries(hashData).map(([url, day]) => ({
        url,
        day,
        // Pega a prioridade do Map. Usa 0 como padrão se não for encontrado.
        priority: zsetMap.has(url) ? parseInt(zsetMap.get(url), 10) : 0, 
    })).filter(banner => zsetMap.has(banner.url)); // Garante que só retorna banners que estão em ambas as estruturas.
    
    return combinedBanners;
};


// ------------------------------------------------------------------------
// --- 4. ROTAS ---
// ------------------------------------------------------------------------

/**
 * POST /api/banners: Upload de imagem, ativação no Redis (com dia e prioridade).
 */
app.post('/api/banners', upload.single('bannerImage'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'Nenhum arquivo enviado.' });
    }
    
    // Obtém o dia e a prioridade
    const day = req.body.day ? req.body.day.toUpperCase() : 'ALL';
    const priority = req.body.priority ? parseInt(req.body.priority, 10) : 0; 
    const validDays = [...Object.values(DAYS_MAP), 'ALL'];

    if (!validDays.includes(day)) {
        return res.status(400).json({ error: `Dia inválido. Use: ${validDays.join(', ')}` });
    }
    if (isNaN(priority) || priority < 0) {
        return res.status(400).json({ error: 'Prioridade inválida. Deve ser um número inteiro não negativo.' });
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

        // 2. Adiciona a URL e o Dia ao HASH de banners ativos
        await redis.hset(ACTIVE_BANNERS_KEY, { [bannerUrl]: day });
        
        // 3. Adiciona a URL e a Prioridade ao ZSET
        await redis.zadd(PRIORITY_BANNERS_KEY, { score: priority, member: bannerUrl });


        console.log(`✅ Banner ${result.public_id} enviado e URL adicionada ao Redis com dia: ${day} e prioridade: ${priority}.`);
        res.status(201).json({ 
            message: 'Upload bem-sucedido e banner ativado!', 
            url: bannerUrl,
            day: day,
            priority: priority // Retorna a prioridade
        });

    } catch (error) {
        console.error('❌ Erro ao processar upload:', error);
        return res.status(500).json({ error: 'Falha ao fazer upload.', details: error.message });
    }
});

/**
 * GET /api/banners: Lista todos os banners ATIVOS *PARA O DIA ATUAL*, ordenados por PRIORIDADE.
 */
app.get('/api/banners', async (req, res) => {
    try {
        const today = new Date().getDay(); 
        const todayKey = DAYS_MAP[today]; 
        
        // Obtém todas as URLs ativas, seus respectivos dias E PRIORIDADES
        const activeBanners = await getActiveBannersWithDay();

        // 1. Filtra banners que são 'ALL' ou correspondem ao dia de hoje
        let filteredBanners = activeBanners
            .filter(banner => banner.day === 'ALL' || banner.day === todayKey);

        // 2. Ordena por prioridade (do maior para o menor)
        filteredBanners.sort((a, b) => b.priority - a.priority);

        // Retorna apenas a lista de URLs, já ordenadas
        const filteredUrls = filteredBanners.map(banner => banner.url);
        
        if (filteredUrls.length === 0) {
            console.log("ℹ️ Nenhum banner ativo encontrado para o dia de hoje.");
        }

        res.json({ banners: filteredUrls, day: todayKey });
        
    } catch (error) {
        console.error('❌ Erro ao carregar banners ativos do Redis:', error);
        return res.status(500).json({ error: 'Falha ao carregar banners ativos.' });
    }
});

/**
 * GET /api/banners/all: Lista todos os banners ATIVOS *com a regra de dia e prioridade*. (Para o Dashboard)
 */
app.get('/api/banners/all', async (req, res) => {
    try {
        // Agora retorna {url, day, priority}
        const activeBanners = await getActiveBannersWithDay(); 
        if (activeBanners.length === 0) {
            console.log("ℹ️ Nenhum banner ativo encontrado.");
        }
        // Retorna a lista de objetos {url, day, priority}
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
        // 2. Remove do ZSET de prioridade
        const removedFromPriority = await redis.zrem(PRIORITY_BANNERS_KEY, url); 

        if (removedFromActive === 0) {
            const wasAlreadyDisabled = await redis.sismember(DISABLED_BANNERS_KEY, url);
            if(wasAlreadyDisabled) {
                 return res.status(404).json({ error: 'Banner já está na lista de desativados.' });
            }
            return res.status(404).json({ error: 'Banner não encontrado na lista de ativos.' });
        }

        // 3. Adiciona ao SET de desativados
        await redis.sadd(DISABLED_BANNERS_KEY, url);

        console.log(`✔️ Banner desativado: ${url}. Removido do HASH (${removedFromActive}) e ZSET (${removedFromPriority}).`);
        return res.json({ message: 'Banner desativado com sucesso.', url });

    } catch (error) {
        console.error('❌ Erro ao desativar banner no Redis:', error);
        return res.status(500).json({ error: 'Falha ao desativar banner.' });
    }
});


/**
 * PUT /api/banners/enable: Move um banner de desativado para ativo, definindo dia E prioridade.
 */
app.put('/api/banners/enable', async (req, res) => {
    const { url, day, priority } = req.body; // NOVO: Recebe priority
    
    const targetDay = day ? day.toUpperCase() : 'ALL';
    const targetPriority = priority ? parseInt(priority, 10) : 0; // NOVO: Target Priority
    const validDays = [...Object.values(DAYS_MAP), 'ALL'];

    if (!url || !validDays.includes(targetDay)) {
        return res.status(400).json({ error: 'A URL do banner é obrigatória e o dia deve ser válido.' });
    }
    // NOVO: Validação da Prioridade
    if (isNaN(targetPriority) || targetPriority < 0) {
        return res.status(400).json({ error: 'A URL do banner é obrigatória, o dia deve ser válido e a prioridade deve ser um número não negativo.' });
    }


    try {
        // 1. Remove do SET de desativados
        const removedFromDisabled = await redis.srem(DISABLED_BANNERS_KEY, url);

        if (removedFromDisabled === 0) {
            const wasAlreadyActive = await redis.hget(ACTIVE_BANNERS_KEY, url);
            if (wasAlreadyActive) {
                return res.status(404).json({ error: 'Banner já está ativo.' });
            }
            return res.status(404).json({ error: 'Banner não encontrado na lista de desativados.' });
        }

        // 2. Adiciona ao HASH de ativos com a nova regra de dia
        await redis.hset(ACTIVE_BANNERS_KEY, { [url]: targetDay });
        
        // 3. Adiciona ao ZSET de prioridade com o novo score
        await redis.zadd(PRIORITY_BANNERS_KEY, { score: targetPriority, member: url });


        console.log(`✔️ Banner reativado: ${url} para o dia: ${targetDay} com prioridade: ${targetPriority}`);
        return res.json({ message: 'Banner reativado com sucesso.', url, day: targetDay, priority: targetPriority });

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
 * NOVO: PUT /api/banners/update-priority: Atualiza a prioridade (score no ZSET) de um banner ATIVO.
 */
app.put('/api/banners/update-priority', async (req, res) => {
    const { url, priority } = req.body;
    
    const targetPriority = priority ? parseInt(priority, 10) : 0;
    
    if (!url || isNaN(targetPriority) || targetPriority < 0) {
        return res.status(400).json({ error: 'A URL do banner e a prioridade (número não negativo) são obrigatórias.' });
    }
    
    try {
        // 1. Verifica se o banner existe no HASH de ativos (apenas banners ativos podem ter prioridade)
        const currentDay = await redis.hget(ACTIVE_BANNERS_KEY, url);

        if (!currentDay) {
            return res.status(404).json({ error: 'Banner não encontrado na lista de ativos. A prioridade só pode ser definida para banners ativos.' });
        }

        // 2. Atualiza o score (prioridade) no ZSET. ZADD atualiza se o membro já existe.
        await redis.zadd(PRIORITY_BANNERS_KEY, { score: targetPriority, member: url });

        console.log(`🔄 Prioridade do Banner atualizada: ${url} para ${targetPriority}.`);
        return res.json({ message: 'Prioridade atualizada com sucesso.', url, priority: targetPriority });

    } catch (error) {
        console.error('❌ Erro ao atualizar a prioridade do banner no Redis:', error);
        return res.status(500).json({ error: 'Falha ao atualizar a prioridade do banner.' });
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
        // 1. Tenta remover a URL dos três locais do Redis (Hash, Set e ZSet)
        const removedActive = await redis.hdel(ACTIVE_BANNERS_KEY, url);
        const removedDisabled = await redis.srem(DISABLED_BANNERS_KEY, url);
        const removedPriority = await redis.zrem(PRIORITY_BANNERS_KEY, url); // NOVO: Remove do ZSET
        const redisRemoved = removedActive + removedDisabled + removedPriority;


        if (redisRemoved === 0) {
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