// server.js (Versão Final com Cloudinary e Upstash Redis)

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
// Habilita o Express a processar o corpo da requisição em JSON (necessário para as rotas PUT e DELETE)
app.use(express.json()); 

// --- Configuração Multer (Armazenamento em Memória) ---
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

const FOLDER_TAG = 'banners_tag'; 

// ------------------------------------------------------------------------
// --- ROTA 1: POST /api/banners (Upload e Ativação) -----------------------
// ------------------------------------------------------------------------
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
        return res.status(500).json({ error: 'Falha ao fazer upload.', details: error.message });
    }
});

// ------------------------------------------------------------------------
// --- ROTA 2: GET /api/banners (Lista Banners ATIVOS) ---------------------
// ------------------------------------------------------------------------
app.get('/api/banners', async (req, res) => {
    
    try {
        // Pega todos os membros do conjunto de banners ativos no Redis
        const activeUrls = await redis.smembers(ACTIVE_BANNERS_KEY);

        if (activeUrls.length === 0) {
            console.log("Nenhum banner ativo encontrado no Redis.");
        }

        res.json({ banners: activeUrls });
        
    } catch (error) {
        console.error('Erro ao carregar banners ativos do Redis:', error);
        return res.status(500).json({ error: 'Falha ao carregar banners ativos do Redis.' });
    }
});

// ------------------------------------------------------------------------
// --- ROTA 3: GET /api/banners/disabled (Lista Banners DESATIVADOS) --------
// ------------------------------------------------------------------------
app.get('/api/banners/disabled', async (req, res) => {
    
    try {
        // Pega todos os membros do conjunto de banners DESATIVADOS no Redis
        const disabledUrls = await redis.smembers(DISABLED_BANNERS_KEY);

        if (disabledUrls.length === 0) {
            console.log("Nenhum banner desativado encontrado no Redis.");
        }

        res.json({ banners: disabledUrls });
        
    } catch (error) {
        console.error('Erro ao carregar banners desativados do Redis:', error);
        return res.status(500).json({ error: 'Falha ao carregar banners desativados do Redis.' });
    }
});

// ------------------------------------------------------------------------
// --- ROTA 4: PUT /api/banners/disable (Desativa um Banner) ----------------
// ------------------------------------------------------------------------
app.put('/api/banners/disable', async (req, res) => {
    const { url } = req.body; 

    if (!url) {
        return res.status(400).json({ error: 'A URL do banner é obrigatória.' });
    }

    try {
        // SMOVE move o elemento de ACTIVE_BANNERS para DISABLED_BANNERS
        const moved = await redis.smove(ACTIVE_BANNERS_KEY, DISABLED_BANNERS_KEY, url);

        if (moved === 1) {
            console.log(`Banner desativado: ${url}`);
            return res.json({ message: 'Banner desativado com sucesso.', url });
        } else {
            return res.status(404).json({ error: 'Banner não encontrado na lista de ativos. (Já desativado ou URL incorreta)' });
        }

    } catch (error) {
        console.error('Erro ao desativar banner no Redis:', error);
        return res.status(500).json({ error: 'Falha ao desativar banner.' });
    }
});

// ------------------------------------------------------------------------
// --- ROTA 5: PUT /api/banners/enable (Reativa um Banner) ------------------
// ------------------------------------------------------------------------
app.put('/api/banners/enable', async (req, res) => {
    const { url } = req.body;

    if (!url) {
        return res.status(400).json({ error: 'A URL do banner é obrigatória.' });
    }

    try {
        // SMOVE move o elemento de DISABLED_BANNERS para ACTIVE_BANNERS
        const moved = await redis.smove(DISABLED_BANNERS_KEY, ACTIVE_BANNERS_KEY, url);

        if (moved === 1) {
            console.log(`Banner reativado: ${url}`);
            return res.json({ message: 'Banner reativado com sucesso.', url });
        } else {
            return res.status(404).json({ error: 'Banner não encontrado na lista de desativados.' });
        }

    } catch (error) {
        console.error('Erro ao reativar banner no Redis:', error);
        return res.status(500).json({ error: 'Falha ao reativar banner.' });
    }
});

// ------------------------------------------------------------------------
// --- ROTA 6: DELETE /api/banners (Exclui permanentemente um Banner) -----
// ------------------------------------------------------------------------
app.delete('/api/banners', async (req, res) => {
    const { url } = req.body;

    if (!url) {
        return res.status(400).json({ error: 'A URL do banner é obrigatória para a exclusão.' });
    }

    try {
        // 1. Tenta remover a URL dos dois conjuntos do Redis
        const removedActive = await redis.srem(ACTIVE_BANNERS_KEY, url);
        const removedDisabled = await redis.srem(DISABLED_BANNERS_KEY, url);

        if (removedActive === 0 && removedDisabled === 0) {
            // Se não foi removido de nenhum lugar, a URL não existe nos registros
            return res.status(404).json({ error: 'Banner não encontrado nos registros do Redis.' });
        }

        // 2. Extrai o public_id da URL do Cloudinary
        // Exemplo: https://res.cloudinary.com/dvxxxxxx/image/upload/v1700000000/banners_folder/public_id_aqui.png
        const parts = url.split('/');
        let publicIdWithFolder;
        
        // Verifica se a URL tem o formato esperado
        if (parts.length >= 2) {
             // O nome do arquivo é o último item (excluindo a extensão)
             const fileNameWithExt = parts[parts.length - 1];
             const fileName = fileNameWithExt.substring(0, fileNameWithExt.lastIndexOf('.'));
             // O nome da pasta é o penúltimo item
             const folderName = parts[parts.length - 2]; 
             publicIdWithFolder = `${folderName}/${fileName}`;
        } else {
             // Falha ao extrair, apenas removeu do Redis
             console.error(`Falha ao extrair public_id de: ${url}. Apenas remoção do Redis realizada.`);
             return res.status(200).json({ message: 'Banner removido do Redis, mas falhou ao extrair o ID para exclusão no Cloudinary.', url, redisRemoved: removedActive + removedDisabled });
        }

        // 3. Deleta do Cloudinary
        const destroyResult = await cloudinary.uploader.destroy(publicIdWithFolder); 
        
        if (destroyResult.result === 'not found') {
             console.warn(`Cloudinary: Arquivo ${publicIdWithFolder} não encontrado na nuvem, mas removido do Redis.`);
             return res.status(200).json({ message: 'Banner excluído com sucesso (removido do Redis e arquivo não encontrado no Cloudinary).', url, redisRemoved: removedActive + removedDisabled });
        } else if (destroyResult.result !== 'ok') {
            console.error('Erro ao deletar no Cloudinary:', destroyResult);
            // Retorna sucesso para o Redis mas notifica o problema no Cloudinary
            return res.status(200).json({ message: 'Banner removido do Redis, mas houve um erro na exclusão do Cloudinary.', url, cloudinaryStatus: destroyResult.result });
        }


        console.log(`Banner EXCLUÍDO permanentemente: ${url}`);
        return res.json({ message: 'Banner excluído com sucesso.', url, redisRemoved: removedActive + removedDisabled });

    } catch (error) {
        console.error('Erro ao excluir banner:', error);
        return res.status(500).json({ error: 'Falha ao excluir banner.' });
    }
});


// --- Exportação Vercel ---
module.exports = app;