const { getRouter } = require("stremio-addon-sdk");
const createAddon = require("./addon");
const crypto = require("crypto");
const { tryParseConfigToken } = require("./cryptoConfig");

// NOTE: In a serverless environment, cold starts will rebuild & preload every time.
// You may wish to add a timeout guard or skip full preload if execution time is tight.

const interfaceCache = new Map();
const CACHE_TTL_MS = parseInt(process.env.CACHE_TTL_MS || (6 * 3600 * 1000).toString(), 10);
const CACHE_ENABLED = (process.env.CACHE_ENABLED || 'true').toLowerCase() !== 'false';

function isConfigToken(token) {
    if (!token) return false;
    if (token.startsWith('enc:')) return true;
    if (token.length < 4) return false;
    return true;
}

function maybeDecryptConfig(token) {
    return tryParseConfigToken(token);
}

async function getInterface(config) {
    const key = JSON.stringify(config);
    const hash = crypto.createHash('md5').update(key).digest('hex');
    
    if (CACHE_ENABLED) {
        const cached = interfaceCache.get(hash);
        if (cached && (Date.now() - cached.timestamp < CACHE_TTL_MS)) {
            return cached.interface;
        }
    }
    
    const addonInterface = await createAddon(config);
    
    if (CACHE_ENABLED) {
        interfaceCache.set(hash, {
            interface: addonInterface,
            timestamp: Date.now()
        });
    }
    
    return addonInterface;
}

module.exports = async function (req, res) {
    try {
        // Parse config from URL path (e.g., /token/manifest.json)
        const urlPath = req.url || '';
        const pathParts = urlPath.split('/').filter(Boolean);
        
        // Extract token from first path segment
        const token = pathParts[0];
        
        if (!token || !isConfigToken(token)) {
            res.statusCode = 400;
            res.setHeader('Content-Type', 'application/json');
            return res.end(JSON.stringify({ error: 'Invalid or missing configuration token' }));
        }
        
        let config;
        try {
            config = maybeDecryptConfig(token);
        } catch (e) {
            console.error('[SERVERLESS] Config parse failed:', e.message);
            res.statusCode = 400;
            res.setHeader('Content-Type', 'application/json');
            return res.end(JSON.stringify({ error: 'Invalid configuration token' }));
        }
        
        // Set provider if not specified
        if (!config.provider) {
            config.provider = config.useXtream ? 'xtream' : 'direct';
        }
        
        const addonInterface = await getInterface(config);
        const router = getRouter(addonInterface);
        
        router(req, res, function () {
            res.statusCode = 404;
            res.end();
        });
    } catch (e) {
        console.error('[SERVERLESS] Error:', e);
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ 
            error: 'Serverless addon error',
            detail: process.env.DEBUG_MODE === 'true' ? e.message : undefined
        }));
    }
};