require("dotenv").config();

const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");
const fs = require("fs");
const http = require("http");
const https = require("https");
const moment = require("moment-timezone");

// ======================================================
// CONFIG
// ======================================================

const TOKEN = process.env.TOKEN;
const CANAL_ID = process.env.CANAL_ID;

const bot = new TelegramBot(TOKEN, {
    polling: true
});

const ARQUIVO_SENTINELAS = "./sentinelas.json";

const httpAgent = new http.Agent({
    keepAlive: true,
    maxSockets: 20
});

const httpsAgent = new https.Agent({
    keepAlive: true,
    maxSockets: 20
});

let sentinelas = [];

// ======================================================
// CONFIG MONITORAMENTO
// ======================================================

const MIN_LINKS = 6;
const MAX_LINKS = 10;

// mínimo para confirmar campanha global
const QUORUM = 4;

// timeout requests
const REQUEST_TIMEOUT = 10000;

// ======================================================
// ESTADO
// ======================================================

let aguardandoLinks = false;
let monitorandoAgora = false;

// evita repost temporário
// codigo -> timestamp
const cuponsPostados = new Map();

// tempo máximo guardado:
// 2 horas
const TEMPO_EXPIRACAO_CUPOM =
    2 * 60 * 60 * 1000;

// ======================================================
// UTIL
// ======================================================

function agoraSP() {
    return moment().tz("America/Sao_Paulo");
}

function salvarSentinelas(lista) {

    fs.writeFileSync(
        ARQUIVO_SENTINELAS,
        JSON.stringify(lista, null, 2)
    );
}

function carregarSentinelas() {

    if (!fs.existsSync(ARQUIVO_SENTINELAS)) {
        return [];
    }

    return JSON.parse(
        fs.readFileSync(ARQUIVO_SENTINELAS)
    );
}

// ======================================================
// JANELA DE MONITORAMENTO
// ======================================================

function obterModoAtual() {

    const agora = agoraSP();

    const minuto = Number(
        agora.format("m")
    );

    // --------------------------------
    // HORA CHEIA
    // 08:00:00 -> 08:00:59
    // polling 5 segundos
    // --------------------------------

    if (minuto === 0) {

        return {
            ativo: true,
            intervalo: 5,
            modo: "TURBO"
        };
    }

    // --------------------------------
    // PRE AQUECIMENTO
    // xx:58 e xx:59
    // polling 10 segundos
    // --------------------------------

    if (
        minuto === 58 ||
        minuto === 59
    ) {

        return {
            ativo: true,
            intervalo: 10,
            modo: "PRE"
        };
    }

    // --------------------------------
    // POS AQUECIMENTO
    // xx:01 e xx:02
    // polling 10 segundos
    // --------------------------------

    if (
        minuto === 1 ||
        minuto === 2
    ) {

        return {
            ativo: true,
            intervalo: 10,
            modo: "POS"
        };
    }

    // --------------------------------
    // ALEATORIOS
    // 05 10 15 20 25...
    // polling 5 segundos
    // --------------------------------

    if (minuto % 5 === 0) {

        return {
            ativo: true,
            intervalo: 5,
            modo: "ALEATORIO"
        };
    }

    return {
        ativo: false
    };
}

// ======================================================
// EXTRAÇÃO CUPONS
// ======================================================

function extrairCupons(html) {

    const encontrados = [];

    // ==================================================
    // VALOR FIXO
    // ==================================================

    const regexValorFixo =
        /Economize\s+R\$(\d+)\s+em\s+pedidos\s+R\$(\d+)\+\s+cupom:\s*([A-Z0-9]+)/gi;

    let match;

    while (
        (match = regexValorFixo.exec(html)) !== null
    ) {

        encontrados.push({

            tipo: "valor_fixo",

            desconto: match[1],

            minimo: match[2],

            codigo: match[3]
        });
    }

    // ==================================================
    // PORCENTAGEM
    // ESQUELETO
    // EVOLUIR DEPOIS
    // ==================================================

    const regexPorcentagem =
        /Ganhe\s+(\d+)%\s+off\s+em\s+compras\s+a\s+partir\s+de\s+R\$\s*([\d.,]+).*?Cupom\s+de\s+desconto:\s*([A-Z0-9]+)/gis;

    while (
        (match = regexPorcentagem.exec(html)) !== null
    ) {

        encontrados.push({

            tipo: "porcentagem",

            desconto: match[1],

            minimo: match[2],

            codigo: match[3]
        });
    }

    return encontrados;
}

// ======================================================
// REQUEST PRODUTO
// ======================================================

async function analisarProduto(url) {

    try {

        const response = await axios.get(url, {

            httpAgent,
            httpsAgent,

            timeout: REQUEST_TIMEOUT,

            headers: {

                "user-agent":
                    "Mozilla/5.0",

                "accept-language":
                    "pt-BR,pt;q=0.9",

                "accept-encoding":
                    "gzip, deflate, br"
            }
        });

        // IMPORTANTISSIMO:
        // usa html
        // extrai
        // joga fora

        const html = response.data;

        const cupons =
            extrairCupons(html);

        return cupons;

    } catch (err) {

        console.log(
            "Erro produto:",
            url
        );

        return [];
    }
}

// ======================================================
// MONITORAMENTO
// ======================================================

async function monitorar(execucaoNome) {

    if (monitorandoAgora) {
        return;
    }

    monitorandoAgora = true;

    try {

        if (!sentinelas.length) {

            console.log(
                "Sem sentinelas."
            );

            return;
        }

        console.log(
            `[${agoraSP().format("HH:mm:ss")}] ${execucaoNome}`
        );

        // ==========================================
        // baixa todos htmls
        // ==========================================

        const resultados =
            await Promise.all(

                sentinelas.map(
                    url => analisarProduto(url)
                )
            );

        // ==========================================
        // quorum
        // ==========================================

        const contador = {};
        const detalhes = {};

        for (const lista of resultados) {

            // evita repetir no mesmo html
            const vistos = new Set();

            for (const item of lista) {

                const chave =
                    item.codigo;

                if (vistos.has(chave)) {
                    continue;
                }

                vistos.add(chave);

                contador[chave] =
                    (contador[chave] || 0) + 1;

                detalhes[chave] = item;
            }
        }

        console.log(contador);

        // ==========================================
        // confirma campanha
        // ==========================================

        for (const codigo in contador) {

            const total =
                contador[codigo];

            if (total < QUORUM) {
                continue;
            }

            // evita repost
            const agoraTimestamp =
                Date.now();

            const ultimoPost =
                cuponsPostados.get(codigo);

            // ainda dentro da janela
            if (
                ultimoPost &&
                agoraTimestamp - ultimoPost <
                TEMPO_EXPIRACAO_CUPOM
            ) {
                continue;
            }

            // salva timestamp novo
            cuponsPostados.set(
                codigo,
                agoraTimestamp
            );

            const item =
                detalhes[codigo];

            let mensagem = "";

            // --------------------------------------
            // VALOR FIXO
            // --------------------------------------

            if (
                item.tipo === "valor_fixo"
            ) {

                mensagem =
                    `<b>CUPOM AMAZON</b>

💰 R$${item.desconto} OFF
🛒 Acima de R$${item.minimo}
🔑 <code>${item.codigo}</code>`;
            }

            // --------------------------------------
            // PORCENTAGEM
            // --------------------------------------

            else if (
                item.tipo === "porcentagem"
            ) {

                mensagem =
                    `<b>CUPOM AMAZON</b>

🔥 ${item.desconto}% OFF
🛒 Acima de R$${item.minimo}
🔑 <code>${item.codigo}</code>`;
            }

            // ======================================
            // envia telegram
            // ======================================

            await bot.sendMessage(
                CANAL_ID,
                mensagem,
                {
                    parse_mode: "HTML"
                }
            );

            console.log(
                "Campanha confirmada:",
                codigo
            );
        }

        // IMPORTANTISSIMO:
        // terminou ciclo
        // tudo vai embora da memória

    } finally {

        monitorandoAgora = false;
    }
}

// ======================================================
// LOOP PRINCIPAL
// ======================================================

setInterval(async () => {

    try {

        const config =
            obterModoAtual();

        if (!config.ativo) {
            return;
        }

        const agora = agoraSP();

        const segundo = Number(
            agora.format("s")
        );

        // respeita polling

        if (
            segundo % config.intervalo !== 0
        ) {
            return;
        }

        await monitorar(
            config.modo
        );

    } catch (err) {

        console.log(
            "Erro loop:",
            err.message
        );
    }

}, 1000);

// ======================================================
// TELEGRAM
// ======================================================

// --------------------------------
// iniciar cadastro
// --------------------------------

bot.onText(/\/links/, async (msg) => {

    aguardandoLinks = true;

    await bot.sendMessage(
        msg.chat.id,
        `Envie entre ${MIN_LINKS} e ${MAX_LINKS} links Amazon separados por quebra de linha.`
    );
});

// --------------------------------
// receber links
// --------------------------------

bot.on("message", async (msg) => {

    if (!aguardandoLinks) {
        return;
    }

    if (!msg.text) {
        return;
    }

    if (
        msg.text.startsWith("/links")
    ) {
        return;
    }

    let links = msg.text

        .split("\n")

        .map(x => x.trim())

        .filter(Boolean)

        .filter(x =>
            x.includes("amazon")
        );

    // remove duplicados

    links = [...new Set(links)];

    // máximo

    if (links.length > MAX_LINKS) {

        return bot.sendMessage(
            msg.chat.id,
            `Máximo permitido: ${MAX_LINKS}`
        );
    }

    // mínimo

    if (links.length < MIN_LINKS) {

        return bot.sendMessage(
            msg.chat.id,
            `Mínimo permitido: ${MIN_LINKS}`
        );
    }

    salvarSentinelas(links);

    sentinelas = links;

    aguardandoLinks = false;

    await bot.sendMessage(
        msg.chat.id,

        `✅ ${links.length} sentinelas salvas.

🛰 PRÉ AQUECIMENTO
58 e 59
• 10 segundos

⚡ HORA CHEIA
00
• 5 segundos

🛰 PÓS AQUECIMENTO
01 e 02
• 10 segundos

🎲 ALEATÓRIOS
05 10 15 20...
• 5 segundos

📡 Sistema armado.`
    );
});

// ======================================================
// LIMPEZA CUPONS POSTADOS
// ======================================================

setInterval(() => {

    const agora =
        Date.now();

    for (
        const [codigo, timestamp]
        of cuponsPostados
    ) {

        if (
            agora - timestamp >
            TEMPO_EXPIRACAO_CUPOM
        ) {

            cuponsPostados.delete(
                codigo
            );
        }
    }

}, 30 * 60 * 1000);

// ======================================================
// MEMORIA
// ======================================================

setInterval(() => {

    const m =
        process.memoryUsage();

    console.log({

        rss:
            `${Math.round(m.rss / 1024 / 1024)} MB`,

        heapUsed:
            `${Math.round(m.heapUsed / 1024 / 1024)} MB`,

        heapTotal:
            `${Math.round(m.heapTotal / 1024 / 1024)} MB`,

        external:
            `${Math.round(m.external / 1024 / 1024)} MB`
    });

}, 60000);

// ======================================================
// START
// ======================================================

sentinelas = carregarSentinelas();

console.log("==================================");
console.log(" BOT SENTINELAS INICIADO ");
console.log("==================================");
