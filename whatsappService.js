const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcodeTerminal = require('qrcode-terminal');
const QRCode = require('qrcode');
const fs = require('fs');

let qrCodeData = null;
let isReady = false;

function getBrowserExecutablePath() {
    const fromEnv =
        process.env.PUPPETEER_EXECUTABLE_PATH ||
        process.env.CHROME_PATH ||
        process.env.CHROMIUM_PATH;

    if (fromEnv && fs.existsSync(fromEnv)) {
        return fromEnv;
    }

    const candidatesByPlatform = {
        win32: [
            'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
            'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
            'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
            'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
        ],
        darwin: [
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
        ],
        linux: [
            '/usr/bin/google-chrome-stable',
            '/usr/bin/google-chrome',
            '/usr/bin/chromium-browser',
            '/usr/bin/chromium',
            '/snap/bin/chromium'
        ]
    };

    const candidates = candidatesByPlatform[process.platform] || [];
    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) {
            return candidate;
        }
    }

    return null;
}

const browserExecutablePath = getBrowserExecutablePath();

if (!browserExecutablePath) {
    console.warn(
        'No se encontró un navegador Chromium/Chrome local. Si falla el inicio, ejecuta: npx puppeteer browsers install chrome'
    );
}

const puppeteerConfig = {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-extensions']
};

if (browserExecutablePath) {
    puppeteerConfig.executablePath = browserExecutablePath;
}

const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: puppeteerConfig
});

console.log('Iniciando cliente de WhatsApp...');

client.on('qr', async (qr) => {
    console.log('--- Código QR de WhatsApp Recibido ---');
    console.log('Escanea este código con tu teléfono para vincular el servicio:');
    qrcodeTerminal.generate(qr, { small: true });
    
    // Generar QR en formato Base64 para la web
    try {
        qrCodeData = await QRCode.toDataURL(qr);
    } catch (err) {
        console.error('Error generando QR Base64:', err);
    }
});

client.on('ready', () => {
    console.log('--- WhatsApp Cliente listo y autenticado ---');
    isReady = true;
    qrCodeData = null; // Limpiar QR una vez listo
});

client.on('authenticated', () => {
    console.log('--- WhatsApp Autenticado correctamente ---');
});

client.on('auth_failure', (msg) => {
    console.error('Fallo de autenticación de WhatsApp:', msg);
    isReady = false;
});

client.on('disconnected', (reason) => {
    console.log('--- WhatsApp Desconectado ---', reason);
    isReady = false;
});

/**
 * Formatea el número de teléfono para WhatsApp.
 * @param {string} phone Número de teléfono.
 * @returns {string} ID de WhatsApp formateado.
 */
function formatWhatsAppId(phone) {
    // Elimina caracteres no numéricos
    let cleanPhone = phone.replace(/\D/g, '');
    
    // Caso especial para México (52): si es celular, a veces requiere un '1' después del '52'
    if (cleanPhone.startsWith('52') && !cleanPhone.startsWith('521') && cleanPhone.length === 12) {
        cleanPhone = '521' + cleanPhone.substring(2);
    }

    // Asegura el formato de WhatsApp (ej: 5215512345678@c.us)
    if (!cleanPhone.endsWith('@c.us')) {
        cleanPhone = `${cleanPhone}@c.us`;
    }
    return cleanPhone;
}

/**
 * Envía un mensaje a un cliente.
 * @param {string} phone Número del cliente.
 * @param {string} message Mensaje a enviar.
 */
async function sendNotification(phone, message) {
    if (!isReady) {
        console.error('No se puede enviar mensaje: Cliente no listo');
        return false;
    }
    try {
        const chatId = formatWhatsAppId(phone);
        await client.sendMessage(chatId, message);
        console.log(`Mensaje enviado exitosamente a: ${phone} (${chatId})`);
        return true;
    } catch (error) {
        console.error(`Error enviando mensaje a ${phone}:`, error);
        return false;
    }
}

module.exports = { 
    client, 
    sendNotification, 
    getQrCode: () => qrCodeData,
    isWhatsAppReady: () => isReady 
};
