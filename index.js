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

// CONFIG
const TOKEN = process.env.TOKEN;
const CANAL_ID = process.env.CANAL_ID;

const bot = new TelegramBot(TOKEN, {
    polling: true
});

const ARQUIVO_SENTINELAS = "./sentinelas.json";

const ARQUIVO_CUPONS =
    "./cupons-postados.json";

const ARQUIVO_PROMOTIONS = "./promotion-aberturas.json";
const LIMITE_ABERTURAS_PROMOTION = 6;

const STORES_FILE =
    "./stores.json";

const INDEX_FILE =
    "./amazon-index.json";

const IMAGEM_INDEX_FILE =
    "./imagem-index.json";

const AFILIADOS_FILE =
    "./afiliacao.json";

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
let AFILIADOS = {};

// CONFIG MONITORAMENTO
const MIN_LINKS = 6;
const MAX_LINKS = 10;

// mínimo para confirmar campanha global
const QUORUM = 1;

// timeout requests
const REQUEST_TIMEOUT = 10000;

// ESTADO
let aguardandoLinks = false;
let monitorandoAgora = false;

let ultimoContadorGlobal = {};

// evita repost temporário
// codigo -> timestamp
const cuponsPostados = new Map();
const cuponsDesaparecidos = new Map();
const historicoPromotions = new Map();
const CICLOS_DESAPARECIMENTO = 3;

function agoraSP() {
    return moment().tz("America/Sao_Paulo");
}

function carregarImagemIndex() {

    if (!fs.existsSync(IMAGEM_INDEX_FILE)) {
        return 0;
    }

    try {

        const dados = JSON.parse(
            fs.readFileSync(IMAGEM_INDEX_FILE)
        );

        return Number(dados.index) || 0;

    } catch {

        return 0;
    }
}

function salvarImagemIndex() {

    fs.writeFileSync(
        IMAGEM_INDEX_FILE,
        JSON.stringify(
            {
                index: imagemIndex
            },
            null,
            2
        )
    );
}

let imagemIndex =
    carregarImagemIndex();

function obterProximaImagem() {

    const pasta =
        path.join(__dirname, "imagem");

    const imagens = fs.readdirSync(pasta)

        .filter(arquivo =>
            /\.(jpg|jpeg|png)$/i.test(arquivo)
        )

        .sort();

    if (!imagens.length) {

        throw new Error(
            "Nenhuma imagem encontrada."
        );
    }

    imagemIndex =
        imagemIndex % imagens.length;

    const imagem =
        path.join(
            pasta,
            imagens[imagemIndex]
        );

    imagemIndex =
        (imagemIndex + 1) %
        imagens.length;

    salvarImagemIndex();

    return imagem;
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

function salvarHistoricoPromotions() {
    fs.writeFileSync(
        ARQUIVO_PROMOTIONS,
        JSON.stringify(Object.fromEntries(historicoPromotions), null, 2)
    );
}

function carregarHistoricoPromotions() {
    if (!fs.existsSync(ARQUIVO_PROMOTIONS)) return;

    try {
        const dados = JSON.parse(
            fs.readFileSync(ARQUIVO_PROMOTIONS, "utf8")
        );

        for (const [id, registro] of Object.entries(dados)) {
            if (!registro || !Array.isArray(registro.extras)) continue;

            const codigosPostados = Array.isArray(registro.codigosPostados)
                ? registro.codigosPostados
                : [];

            if (codigosPostados.some(codigo => !cuponsPostados.has(codigo))) {
                continue;
            }

            historicoPromotions.set(id, {
                sucessos: Math.min(
                    LIMITE_ABERTURAS_PROMOTION,
                    Math.max(0, Number(registro.sucessos) || 0)
                ),
                extras: registro.extras,
                codigosPostados
            });
        }
    } catch (err) {
        console.log("Erro ao carregar contagem dos popups:", err.message);
    }
}

function marcarPromotionPostada(codigo) {
    let alterou = false;

    for (const registro of historicoPromotions.values()) {
        if (
            registro.extras.some(extra => extra.codigo === codigo) &&
            !registro.codigosPostados.includes(codigo)
        ) {
            registro.codigosPostados.push(codigo);
            alterou = true;
        }
    }

    if (alterou) salvarHistoricoPromotions();
}

function limparContagemDoCupom(codigo) {
    let alterou = false;

    for (const [id, registro] of historicoPromotions) {
        if (
            registro.extras.some(extra => extra.codigo === codigo) ||
            registro.codigosPostados.includes(codigo)
        ) {
            historicoPromotions.delete(id);
            alterou = true;
            console.log("Contagem reiniciada para promotion:", id);
        }
    }

    if (alterou) salvarHistoricoPromotions();
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

function carregarAfiliados() {

    if (!fs.existsSync(AFILIADOS_FILE)) {

        console.log(
            "afiliacao.json não encontrado."
        );

        return;
    }

    AFILIADOS = JSON.parse(
        fs.readFileSync(AFILIADOS_FILE)
    );
}

function obterLinkAfiliado(url) {

    const asin =
        url.match(
            /\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i
        )?.[1];

    if (!asin) {
        return url;
    }
    return AFILIADOS[asin] || url;
}

function extrairBlocosPromocao(html) {

    // pega apenas blocos que contenham promotion popup
    // reduz MUITO o html processado
    const matches = html.match(/<div[^>]*>[\s\S]*?promotion\/details\/popup\/[A-Z0-9]+[\s\S]*?<\/div>/gi);

    if (!matches) {
        return "";
    }
    return matches.join("\n");
}

// JANELA OPERACAO
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

    // funciona: 07:30 -> 00:10
    return (
        totalAtual >= inicio ||
        totalAtual <= fim
    );
}

// JANELA DE MONITORAMENTO
function obterModoAtual() {

    const agora = agoraSP();
    const minuto = Number(
        agora.format("m")
    );

    // HORA CHEIA 08:00:00 -> 08:00:59 polling 5 segundos
    if (minuto === 0) {

        return {
            ativo: true,
            intervalo: 5,
            modo: "TURBO"
        };
    }

    // PRE AQUECIMENTO xx:58 e xx:59 polling 10 segundos
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

    // POS AQUECIMENTO xx:01 e xx:02 polling 10 segundos
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

    // ALEATORIOS - 05 10 15 20 25... polling 5 segundos
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

// EXTRAÇÃO CUPONS
function extrairCupons(html) {

    const encontrados = [];
    const vendaTerceiros =
        /produtos vendidos por vendedores terceiros/i.test(html);
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

    // TERMOS COMPLETOS
    let match;
    const regexCupomCompleto =
        /Ganhe\s+(?:(\d+)%|(?:R\$)?\s*([\d.,]+))(?:\s*off)?(?=[\s\S]*?R\$\s*([\d.,]+)[\s\S]*?O benefício máximo que você pode receber com esta promoção é limitado a\s*(?:R\$)?\s*([\d.,]+))(?=[\s\S]*?Cupom de desconto:\s*(?:<groupClaimCode>)?([A-Z0-9]+)(?:<\/groupClaimCode>)?)/gi;

    while ((match = regexCupomCompleto.exec(html)) !== null) {

        encontrados.push({
            tipo: "cupomCompleto",
            porcentagem: match[1] || null,
            valorReais: match[2] || null,
            minimo: match[3],
            limite: match[4],
            codigo: match[5],
            vendaTerceiros
        });
    }

    // Se não encontrou nenhum cupom completo,
    // tenta o modelo sem valor mínimo em R$
    if (!encontrados.some(x => x.tipo === "cupomCompleto")) {

        const regexCupomSemMinimo =
            /Ganhe\s+(?:(\d+)%|(?:R\$)?\s*([\d.,]+))(?:\s*off)?[\s\S]*?O benefício máximo que você pode receber com esta promoção é limitado a\s*(?:R\$)?\s*([\d.,]+)[\s\S]*?Cupom de desconto:\s*(?:<groupClaimCode>)?([A-Z0-9]+)(?:<\/groupClaimCode>)?/gi;

        while ((match = regexCupomSemMinimo.exec(html)) !== null) {

            encontrados.push({
                tipo: "cupomCompleto",
                porcentagem: match[1] || null,
                valorReais: match[2] || null,
                minimo: null,
                limite: match[3],
                codigo: match[4],
                vendaTerceiros
            });
        }
    }

    const regexCodigoFallback =
        /<groupClaimCode>([A-Z0-9]+)<\/groupClaimCode>/gi;

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

async function obterExtrasPromotion(id, cachePromotions) {
    if (cachePromotions.has(id)) {
        return cachePromotions.get(id);
    }

    const tarefa = (async () => {
        const registro = historicoPromotions.get(id);

        if (registro?.sucessos >= LIMITE_ABERTURAS_PROMOTION) {
            return registro.extras;
        }

        const popup = await axios.get(
            `https://www.amazon.com.br/promotion/details/popup/${id}`,
            {
                httpAgent,
                httpsAgent,
                timeout: REQUEST_TIMEOUT,
                headers: {
                    "user-agent": "Mozilla/5.0",
                    "accept-language": "pt-BR,pt;q=0.9",
                    "accept-encoding": "gzip, deflate, br"
                }
            }
        );

        if (popup.status !== 200 || typeof popup.data !== "string") {
            return [];
        }

        const textoPopup = popup.data
            .replace(/<[^>]*>/g, " ")
            .replace(/&nbsp;|&#160;|&#xA0;/gi, " ")
            .replace(/\s+/g, " ");

        const extras = extrairCupons(textoPopup);

        if (!extras.some(x => x.tipo === "cupomCompleto")) {
            extras.push(...extrairCupons(popup.data));
        }

        const cuponsExtraidos = extras.filter(extra =>
            extra.tipo === "cupomCompleto" && extra.codigo
        );

        if (cuponsExtraidos.length) {
            historicoPromotions.set(id, {
                sucessos: Math.min(
                    LIMITE_ABERTURAS_PROMOTION,
                    (registro?.sucessos || 0) + 1
                ),
                extras,
                codigosPostados: registro?.codigosPostados || []
            });

            salvarHistoricoPromotions();

            console.log(
                "Popup extraído:",
                id,
                `${historicoPromotions.get(id).sucessos}/${LIMITE_ABERTURAS_PROMOTION}`
            );
        }

        return extras;
    })();

    cachePromotions.set(id, tarefa);
    return tarefa;
}

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

        // extrai ids promotion
        const encontrados =
            extrairCupons(html);

        console.log("URL:", url);
        console.log("ENCONTRADOS PAGINA:");
        console.log(encontrados);

        const promotions =
            encontrados.filter(
                x => x.tipo === "promotion"
            );

        const promotionsVistas =
            new Set();
        // cupons finais
        const cupons = [];
        // abre popup termos
        for (const promo of promotions) {


            if (promotionsVistas.has(promo.id)) {
                continue;
            }

            promotionsVistas.add(promo.id);
            try {

                const extras = await obterExtrasPromotion(promo.id, cachePromotions);
                // mantém apenas cupons reais
                for (const extra of extras) {
                    if (
                        extra.tipo === "cupomCompleto" ||
                        extra.tipo === "codigoFallback"
                    ) {
                        cupons.push({
                            ...extra,
                            url
                        });
                    }
                }
            } catch (err) {
                console.log("Erro popup:", promo.id, {
                    status: err.response?.status,
                    codigo: err.code,
                    mensagem: err.message
                });
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

        // baixa todos htmls
        const resultados =
            await Promise.all(

                sentinelas.map(
                    url => analisarProduto(url, cachePromotions)
                )
            );

        // quorum
        const contador = {};
        const detalhes = {};
        const linksPorCupom = {};

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

                if (!linksPorCupom[chave]) {
                    linksPorCupom[chave] = [];
                }

                linksPorCupom[chave].push(item.url);
            }
        }

        console.log(contador);
        ultimoContadorGlobal = contador;

        for (const codigo in contador) {

            const total =
                contador[codigo];

            if (total < QUORUM) {
                continue;
            }

            if (cuponsPostados.has(codigo)) {
                continue;
            }

            cuponsPostados.set(
                codigo,
                true
            );

            cuponsDesaparecidos.set(
                codigo,
                0
            );

            salvarCuponsPostados();
            marcarPromotionPostada(codigo);

            const item = detalhes[codigo];

            console.log("===== ENVIO =====");
            console.log("Código:", codigo);
            console.log("Item:", item);

            let mensagem;

            if (
                item &&
                item.tipo === "cupomCompleto"
            ) {

                if (item.porcentagem) {

                    const linksValidos =
                        [...new Set(
                            linksPorCupom[codigo] || []
                        )];

                    const linkAmazon =
                        obterLinkAfiliado(
                            linksValidos[
                            Math.floor(
                                Math.random() *
                                linksValidos.length
                            )
                            ]
                        );

                    mensagem =
                        `Cupom AMAZON App

${item.limite
                            ? `${item.porcentagem}% até <b>R$${item.limite} OFF</b>`
                            : `<b>${item.porcentagem}% OFF</b>`
                        } 🔑 <code>${item.codigo}</code>
${item.minimo ? `acima de R$${item.minimo.replace(/[.,]$/, "").replace(",", ".")}` : ""}

${item.vendaTerceiros ? `vendedores terceiros (não Amazon)
` : ""}<b>🔗 Resgate no link 👉: ${linkAmazon}</b>
# Anuncio @paradoxopromos`;

                } else {

                    const linksValidos =
                        [...new Set(
                            linksPorCupom[codigo] || []
                        )];

                    const linkAmazon =
                        obterLinkAfiliado(
                            linksValidos[
                            Math.floor(
                                Math.random() *
                                linksValidos.length
                            )
                            ]
                        );
                    mensagem =
                        `Cupom AMAZON App

<b>R$${item.valorReais} OFF</b> em R$${item.minimo.replace(/[.,]$/, "")} 🔑 <code>${item.codigo}</code>

${item.vendaTerceiros ? `vendedores terceiros (não Amazon)
` : ""}<b>🔗 Resgate no link 👉: ${linkAmazon}</b>
# Anuncio @paradoxopromos`;
                }

            } else {
                // não envia fallback feio
                continue;
            }

            console.log("Vai enviar ao Telegram");

            await bot.sendPhoto(
                CANAL_ID,
                obterProximaImagem(),
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

    } finally {
        monitorandoAgora = false;
    }
}

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

setInterval(() => {

    console.log(
        "cuponsPostados:",
        [...cuponsPostados.keys()]
    );

    if (!Object.keys(ultimoContadorGlobal).length) {

        console.log(
            "SAIU POR CONTADOR VAZIO"
        );
        return;
    }

    for (const codigo of cuponsPostados.keys()) {

        const total =
            ultimoContadorGlobal[codigo] || 0;

        console.log(
            "CUPOM:",
            codigo,
            "TOTAL:",
            total
        );

        if (total > 0) {

            console.log(
                "ZEROU DESAPARECIMENTO"
            );

            cuponsDesaparecidos.set(
                codigo,
                0
            );

            continue;
        }

        const ciclos =
            (cuponsDesaparecidos.get(codigo) || 0) + 1;

        console.log(
            "CICLOS:",
            ciclos
        );

        cuponsDesaparecidos.set(
            codigo,
            ciclos
        );

        if (
            ciclos >= CICLOS_DESAPARECIMENTO
        ) {

            console.log(
                "REMOVENDO:",
                codigo
            );

            cuponsPostados.delete(codigo);
            limparContagemDoCupom(codigo);
            cuponsDesaparecidos.delete(codigo);
            salvarCuponsPostados();
        }
    }

}, 5 * 60 * 1000);

sentinelas = carregarSentinelas();
carregarCuponsPostados();
carregarHistoricoPromotions();
carregarStores();
carregarAfiliados();

console.log(" BOT SENTINELAS INICIADO ");