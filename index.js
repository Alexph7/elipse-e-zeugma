const dns = require("dns");

dns.setDefaultResultOrder("ipv4first");
dns.lookup("api.telegram.org", { all: true }, (err, addresses) => {
    console.log("DNS Telegram:", addresses);
});

require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
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

const ARQUIVO_CUPONS =
    "./cupons-postados.json";

const STORES_FILE =
    "./stores.json";

const INDEX_FILE =
    "./amazon-index.json";

const httpAgent = new http.Agent({
    keepAlive: true,
    maxSockets: 20,
    family: 4
});

const httpsAgent = new https.Agent({
    keepAlive: true,
    maxSockets: 20,
    family: 4
});

let sentinelas = [];

let STORES = {};

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
const TEMPO_EXPIRACAO_CUPOM =
    24 * 60 * 60 * 1000;

// ======================================================
// UTIL
// ======================================================

function agoraSP() {
    return moment().tz("America/Sao_Paulo");
}

function carregarAmazonIndex() {

    if (!fs.existsSync(INDEX_FILE)) {
        return 0;
    }

    try {

        const dados = JSON.parse(
            fs.readFileSync(INDEX_FILE)
        );

        return Number(dados.index) || 0;

    } catch {

        return 0;
    }
}

function salvarAmazonIndex() {

    fs.writeFileSync(
        INDEX_FILE,
        JSON.stringify(
            {
                index: amazonLinkIndex
            },
            null,
            2
        )
    );
}

let amazonLinkIndex =
    carregarAmazonIndex();

function obterProximoLinkAmazon() {

    if (
        !STORES.A ||
        !Array.isArray(STORES.A.links) ||
        !STORES.A.links.length
    ) {

        return "https://amazon.com.br";
    }

    amazonLinkIndex =
        amazonLinkIndex %
        STORES.A.links.length;

    const link =
        STORES.A.links[amazonLinkIndex];

    amazonLinkIndex =
        (amazonLinkIndex + 1) %
        STORES.A.links.length;

    salvarAmazonIndex();

    return link;
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

function salvarCuponsPostados() {

    const obj = Object.fromEntries(
        cuponsPostados
    );

    fs.writeFileSync(

        ARQUIVO_CUPONS,

        JSON.stringify(obj, null, 2)
    );
}

function carregarCuponsPostados() {

    if (
        !fs.existsSync(
            ARQUIVO_CUPONS
        )
    ) {
        return;
    }

    const dados = JSON.parse(

        fs.readFileSync(
            ARQUIVO_CUPONS
        )
    );

    for (const codigo in dados) {

        cuponsPostados.set(
            codigo,
            dados[codigo]
        );
    }
}

function carregarStores() {

    if (!fs.existsSync(STORES_FILE)) {

        console.log(
            "stores.json não encontrado."
        );

        return;
    }

    STORES = JSON.parse(

        fs.readFileSync(
            STORES_FILE
        )
    );
}

function extrairBlocosPromocao(html) {

    // pega apenas blocos que contenham promotion popup
    // reduz MUITO o html processado

    const matches = html.match(

        /<div[^>]*>[\s\S]*?promotion\/details\/popup\/[A-Z0-9]+[\s\S]*?<\/div>/gi

    );

    if (!matches) {
        return "";
    }

    return matches.join("\n");
}

// ======================================================
// JANELA OPERACAO
// ======================================================

// liga: 07:30
const HORA_INICIO = 7;
const MINUTO_INICIO = 30;

// pausa: 00:10
const HORA_FIM = 0;
const MINUTO_FIM = 10;

function dentroHorarioOperacao() {

    const agora = agoraSP();

    const hora =
        Number(agora.format("H"));

    const minuto =
        Number(agora.format("m"));

    const totalAtual =
        (hora * 60) + minuto;

    const inicio =
        (HORA_INICIO * 60) + MINUTO_INICIO;

    const fim =
        (HORA_FIM * 60) + MINUTO_FIM;

    // funciona:
    // 07:30 -> 00:10

    return (
        totalAtual >= inicio ||
        totalAtual <= fim
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
    // PROMOTION IDS
    // ==================================================

    const regexPromotion =
        /promotion\/details\/popup\/([A-Z0-9]+)/gi;

    let promotionMatch;

    while (
        (promotionMatch = regexPromotion.exec(html)) !== null
    ) {

        encontrados.push({

            tipo: "promotion",

            id: promotionMatch[1]
        });
    }

    // ==================================================
    // TERMOS COMPLETOS
    // ==================================================

    let match;

    const regexTermos =
        /Ganhe\s+(?:(\d+)%|R\$\s*([\d.,\u00A0]+))(?:\s+off)?\s+em\s+compras\s+(?:a\s+partir\s+de|acima\s+de)\s+R\$\s*([\d.,\u00A0]+)(?:\s+\(limitado\s+a\s+R\$\s*([\d.,\u00A0]+)\))?.*?Cupom\s+de\s+desconto:\s*<groupClaimCode>([A-Z0-9]+)<\/groupClaimCode>/gis;

    const regexCodigoFallback =
        /<groupClaimCode>([A-Z0-9]+)<\/groupClaimCode>/gi;

    while (
        (match = regexTermos.exec(html)) !== null
    ) {

        encontrados.push({

            tipo: "cupomCompleto",

            porcentagem: match[1] || null,

            valorReais: match[2] || null,

            minimo: match[3],

            limite: match[4] || null,

            codigo: match[5]
        });
    }

    while (
        (match = regexCodigoFallback.exec(html)) !== null
    ) {

        encontrados.push({

            tipo: "codigoFallback",

            codigo: match[1]
        });
    }

    return encontrados;
}

// ======================================================
// REQUEST PRODUTO
// ======================================================

async function analisarProduto(url, cachePromotions) {

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


        let htmlBruto = response.data;

        const html =
            extrairBlocosPromocao(htmlBruto);

        htmlBruto = null;

        // ==========================================
        // extrai ids promotion
        // ==========================================

        const encontrados =
            extrairCupons(html);

        console.log("================================");
        console.log("URL:", url);
        console.log("ENCONTRADOS PAGINA:");
        console.log(encontrados);
        console.log("================================");

        const promotions =
            encontrados.filter(
                x => x.tipo === "promotion"
            );

        const promotionsVistas =
            new Set();

        // cupons finais
        const cupons = [];

        // ==========================================
        // abre popup termos
        // ==========================================

        for (const promo of promotions) {


            if (promotionsVistas.has(promo.id)) {
                continue;
            }

            promotionsVistas.add(promo.id);
            try {

                let extras = cachePromotions.get(promo.id);

                if (extras === undefined) {

                    const popup =
                        await axios.get(

                            `https://www.amazon.com.br/promotion/details/popup/${promo.id}`,

                            {

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
                            }
                        );

                    console.log("================================");
                    console.log("POPUP:", promo.id);
                    console.log(
                        popup.data
                            .replace(/\s+/g, " ")
                            .slice(0, 5000)
                    );
                    console.log("================================");

                    extras =
                        extrairCupons(
                            popup.data
                        );

                    if (promo.id === "A18BVK047WQ0HR") {
                        console.log(
                            popup.data.match(/<groupClaimCode>(.*?)<\/groupClaimCode>/i)
                        );
                    }

                    console.log("================================");
                    console.log("EXTRAS EXTRAIDOS:", promo.id);
                    console.log(
                        JSON.stringify(
                            extras,
                            null,
                            2
                        )
                    );
                    console.log("================================");

                    // salva no cache
                    cachePromotions.set(
                        promo.id,
                        extras
                    );
                }

                // mantém apenas cupons reais
                cupons.push(

                    ...extras.filter(
                        x =>
                            x.tipo === "cupomCompleto" ||
                            x.tipo === "codigoFallback"
                    )
                );
            } catch (err) {

                console.log(
                    "Erro popup:",
                    promo.id
                );
            }
        }

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

        const cachePromotions = new Map();

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
                    url => analisarProduto(url, cachePromotions)
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

                if (!item.codigo) {
                    continue;
                }

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

            salvarCuponsPostados();

            const item =
                detalhes[codigo];

            let mensagem;

            // --------------------------------------
            // CUPOM COMPLETO
            // --------------------------------------

            if (
                item &&
                item.tipo === "cupomCompleto"
            ) {

                if (item.porcentagem) {
                    const linkAmazon =
                        obterProximoLinkAmazon();

                    mensagem =
                        `<b>Cupom AMAZON App</b>

${item.limite
                            ? `✅ ${item.porcentagem}% até <b>R$${item.limite} OFF</b>`
                            : `<b>✅ ${item.porcentagem}% OFF</b>`
                        } 🔑 <code>${item.codigo}</code>
acima de R$${item.minimo}

<b>🔗Ative no link: ${linkAmazon}</b>`;

                } else {
                    const linkAmazon = obterProximoLinkAmazon();
                    mensagem =
                        `<b>CUPOM AMAZON APP</b>

<b>✅ R$${item.valorReais} OFF</b> em R$${item.minimo} 🔑 <code>${item.codigo}</code>

<b>🔗Ative no link: ${linkAmazon}</b>`;
                }

            } else {

                // não envia fallback feio
                continue;
            }
            // ======================================
            // envia telegram
            // ======================================

            await bot.sendPhoto(
                CANAL_ID,
                path.join(__dirname, "imagem", "amazon.jpg"),
                {
                    caption: mensagem,
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

        // fora da janela operacional
        if (!dentroHorarioOperacao()) {
            return;
        }

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
// FALLBACK LEVE
// ======================================================

setInterval(async () => {

    try {

        // fora da janela operacional
        if (!dentroHorarioOperacao()) {
            return;
        }

        const agora = agoraSP();

        const minuto = Number(
            agora.format("m")
        );

        const segundo = Number(
            agora.format("s")
        );

        // ignora minutos já monitorados
        if (
            minuto === 0 ||
            minuto === 1 ||
            minuto === 2 ||
            minuto === 58 ||
            minuto === 59 ||
            minuto % 5 === 0
        ) {
            return;
        }

        // executa apenas :00 e :10
        if (
            segundo !== 0 &&
            segundo !== 10
        ) {
            return;
        }

        await monitorar(
            "FALLBACK-LEVE"
        );

    } catch (err) {

        console.log(
            "Erro fallback:",
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
            salvarCuponsPostados();
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

carregarCuponsPostados();

carregarStores();

console.log("==================================");
console.log(" BOT SENTINELAS INICIADO ");
console.log("==================================");
