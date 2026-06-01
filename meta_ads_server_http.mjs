#!/usr/bin/env node
/**
 * Servidor MCP - Meta Ads para Escala Ads
 * Versão HTTP/SSE — deploy Railway/Render/VPS
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import http from "http";
import { URL } from "url";

// ─── Configuração ─────────────────────────────────────────────────────────────
const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN || "";
const META_BUSINESS_ID  = process.env.META_BUSINESS_ID  || "";
const PORT              = process.env.PORT || 3000;
const API_SECRET        = process.env.API_SECRET || ""; // opcional: protege o endpoint
const API_VERSION       = "v20.0";
const BASE_URL          = `https://graph.facebook.com/${API_VERSION}`;

if (!META_ACCESS_TOKEN) process.stderr.write("[meta-ads-escala] ERRO: META_ACCESS_TOKEN não definido.\n");
if (!META_BUSINESS_ID)  process.stderr.write("[meta-ads-escala] ERRO: META_BUSINESS_ID não definido.\n");

// ─── Helpers ──────────────────────────────────────────────────────────────────
async function metaGet(endpoint, params = {}) {
  params.access_token = META_ACCESS_TOKEN;
  const query = new URLSearchParams(params).toString();
  const url   = `${BASE_URL}/${endpoint}?${query}`;
  try {
    const res  = await fetch(url);
    const data = await res.json();
    if (data.error) process.stderr.write(`[meta-ads-escala] Erro GET: ${JSON.stringify(data.error)}\n`);
    return data;
  } catch (e) {
    process.stderr.write(`[meta-ads-escala] Erro fetch GET: ${e.message}\n`);
    return { error: e.message };
  }
}

async function metaPost(endpoint, body = {}) {
  body.access_token = META_ACCESS_TOKEN;
  const url = `${BASE_URL}/${endpoint}`;
  try {
    const res  = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (data.error) process.stderr.write(`[meta-ads-escala] Erro POST: ${JSON.stringify(data.error)}\n`);
    return data;
  } catch (e) {
    process.stderr.write(`[meta-ads-escala] Erro fetch POST: ${e.message}\n`);
    return { error: e.message };
  }
}

async function metaGetAll(endpoint, params = {}) {
  const results = [];
  let data = await metaGet(endpoint, { ...params, limit: "200" });
  if (data.error) return data;
  results.push(...(data.data || []));
  while (data.paging?.next) {
    const next = new URL(data.paging.next);
    const nextParams = Object.fromEntries(next.searchParams.entries());
    data = await metaGet(endpoint, nextParams);
    if (data.error) break;
    results.push(...(data.data || []));
  }
  return { data: results };
}

// ─── Factory: cria uma instância do servidor MCP ──────────────────────────────
function createMcpServer() {
  const server = new Server(
    { name: "meta-ads-escala", version: "2.0.0" },
    { capabilities: { tools: {} } }
  );

  // ── Ferramentas ─────────────────────────────────────────────────────────────
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [

      // LEITURA
      { name: "listar_contas", description: "Lista todas as contas de anúncios do Business Manager (owned + client)", inputSchema: { type: "object", properties: {}, required: [] } },
      { name: "listar_campanhas", description: "Lista as campanhas de uma conta de anúncios", inputSchema: { type: "object", properties: { conta_id: { type: "string", description: "ID da conta (ex: act_123456789)" }, status: { type: "string", description: "ACTIVE | PAUSED | ALL (padrão: ALL)", default: "ALL" } }, required: ["conta_id"] } },
      { name: "listar_conjuntos_anuncios", description: "Lista os conjuntos de anúncios de uma campanha", inputSchema: { type: "object", properties: { campanha_id: { type: "string", description: "ID da campanha" }, status: { type: "string", description: "ACTIVE | PAUSED | ALL", default: "ALL" } }, required: ["campanha_id"] } },
      { name: "listar_anuncios", description: "Lista os anúncios de um conjunto ou campanha", inputSchema: { type: "object", properties: { id: { type: "string", description: "ID do conjunto ou campanha" }, nivel: { type: "string", description: "adset | campaign", default: "adset" } }, required: ["id"] } },
      { name: "listar_publicos", description: "Lista os públicos personalizados da conta", inputSchema: { type: "object", properties: { conta_id: { type: "string" } }, required: ["conta_id"] } },
      { name: "listar_paginas", description: "Lista as páginas do Facebook no Business Manager", inputSchema: { type: "object", properties: {}, required: [] } },
      { name: "listar_pixels", description: "Lista os pixels Meta do Business Manager", inputSchema: { type: "object", properties: {}, required: [] } },
      { name: "listar_imagens", description: "Lista as imagens da biblioteca da conta", inputSchema: { type: "object", properties: { conta_id: { type: "string" } }, required: ["conta_id"] } },
      { name: "metricas_campanha", description: "Métricas de uma campanha", inputSchema: { type: "object", properties: { campanha_id: { type: "string" }, periodo: { type: "string", default: "last_30d" } }, required: ["campanha_id"] } },
      { name: "resumo_conta", description: "Resumo de performance de uma conta", inputSchema: { type: "object", properties: { conta_id: { type: "string" }, periodo: { type: "string", default: "last_30d" } }, required: ["conta_id"] } },
      { name: "resumo_todos_clientes", description: "Resumo de TODAS as contas ativas", inputSchema: { type: "object", properties: { periodo: { type: "string", default: "last_30d" } }, required: [] } },
      { name: "metricas_conta_por_campanha", description: "Métricas por campanha dentro de uma conta", inputSchema: { type: "object", properties: { conta_id: { type: "string" }, periodo: { type: "string", default: "last_30d" } }, required: ["conta_id"] } },

      // CRIAÇÃO
      {
        name: "criar_campanha",
        description: "Cria uma nova campanha de anúncios",
        inputSchema: {
          type: "object",
          properties: {
            conta_id: { type: "string" }, nome: { type: "string" },
            objetivo: { type: "string", description: "OUTCOME_AWARENESS | OUTCOME_TRAFFIC | OUTCOME_ENGAGEMENT | OUTCOME_LEADS | OUTCOME_APP_PROMOTION | OUTCOME_SALES" },
            status: { type: "string", default: "PAUSED" },
            orcamento_diario: { type: "number" }, orcamento_total: { type: "number" },
            data_inicio: { type: "string" }, data_fim: { type: "string" },
            limite_gasto: { type: "number" }, bid_strategy: { type: "string" },
            special_ad_categories: { type: "array", items: { type: "string" } },
          },
          required: ["conta_id", "nome", "objetivo"],
        },
      },
      {
        name: "criar_conjunto_anuncios",
        description: "Cria um conjunto de anúncios dentro de uma campanha",
        inputSchema: {
          type: "object",
          properties: {
            conta_id: { type: "string" }, campanha_id: { type: "string" }, nome: { type: "string" },
            status: { type: "string", default: "PAUSED" },
            orcamento_diario: { type: "number" }, orcamento_total: { type: "number" },
            data_inicio: { type: "string" }, data_fim: { type: "string" },
            objetivo_otimizacao: { type: "string", description: "LINK_CLICKS | LANDING_PAGE_VIEWS | IMPRESSIONS | REACH | OFFSITE_CONVERSIONS | LEAD_GENERATION | VALUE | QUALITY_LEAD | CONVERSATIONS" },
            evento_cobranca: { type: "string", description: "IMPRESSIONS | LINK_CLICKS | PAGE_LIKES | APP_INSTALLS | LEAD_GENERATION | THRUPLAY" },
            pixel_id: { type: "string" }, evento_conversao: { type: "string" },
            paises: { type: "array", items: { type: "string" } },
            idade_min: { type: "number", default: 18 }, idade_max: { type: "number", default: 65 },
            genero: { type: "array", items: { type: "number" } },
            interesses: { type: "array", items: { type: "object" } },
            publicos_incluir: { type: "array", items: { type: "string" } },
            publicos_excluir: { type: "array", items: { type: "string" } },
            placements_automaticos: { type: "boolean", default: true },
            placements_manuais: { type: "object" },
            bid_amount: { type: "number" },
          },
          required: ["conta_id", "campanha_id", "nome", "objetivo_otimizacao", "evento_cobranca"],
        },
      },
      {
        name: "criar_criativo",
        description: "Cria um criativo de anúncio com imagem ou vídeo",
        inputSchema: {
          type: "object",
          properties: {
            conta_id: { type: "string" }, nome: { type: "string" }, pagina_id: { type: "string" },
            instagram_id: { type: "string" }, titulo: { type: "string" }, corpo: { type: "string" },
            descricao: { type: "string" }, url_destino: { type: "string" }, url_display: { type: "string" },
            cta: { type: "string", description: "LEARN_MORE | SHOP_NOW | SIGN_UP | DOWNLOAD | GET_QUOTE | CONTACT_US | SEND_MESSAGE | WHATSAPP_MESSAGE | SUBSCRIBE | APPLY_NOW" },
            imagem_hash: { type: "string" }, video_id: { type: "string" },
            formato: { type: "string", default: "SINGLE_IMAGE" },
            carousel_cards: { type: "array", items: { type: "object" } },
            url_parametros: { type: "string" },
          },
          required: ["conta_id", "nome", "pagina_id", "corpo", "url_destino", "cta"],
        },
      },
      {
        name: "criar_anuncio",
        description: "Cria um anúncio associando um criativo a um conjunto",
        inputSchema: {
          type: "object",
          properties: {
            conta_id: { type: "string" }, conjunto_id: { type: "string" },
            nome: { type: "string" }, criativo_id: { type: "string" },
            status: { type: "string", default: "PAUSED" },
          },
          required: ["conta_id", "conjunto_id", "nome", "criativo_id"],
        },
      },
      { name: "fazer_upload_imagem", description: "Upload de imagem via URL para a biblioteca da conta", inputSchema: { type: "object", properties: { conta_id: { type: "string" }, url_imagem: { type: "string" } }, required: ["conta_id", "url_imagem"] } },
      {
        name: "criar_publico_personalizado",
        description: "Cria um público personalizado (website, engagement, lista)",
        inputSchema: {
          type: "object",
          properties: {
            conta_id: { type: "string" }, nome: { type: "string" }, descricao: { type: "string" },
            tipo: { type: "string", description: "WEBSITE | CUSTOMER_LIST | ENGAGEMENT | APP_ACTIVITY" },
            pixel_id: { type: "string" }, regras_website: { type: "object" },
            retencao_dias: { type: "number", default: 30 },
            engagement_tipo: { type: "string" }, engagement_id: { type: "string" },
          },
          required: ["conta_id", "nome", "tipo"],
        },
      },
      {
        name: "criar_publico_semelhante",
        description: "Cria um público Lookalike baseado num público existente",
        inputSchema: {
          type: "object",
          properties: {
            conta_id: { type: "string" }, publico_origem_id: { type: "string" },
            paises: { type: "array", items: { type: "string" } },
            tamanho: { type: "number", default: 1 }, nome: { type: "string" },
          },
          required: ["conta_id", "publico_origem_id", "paises", "nome"],
        },
      },

      // GESTÃO
      { name: "atualizar_campanha", description: "Atualiza uma campanha existente", inputSchema: { type: "object", properties: { campanha_id: { type: "string" }, nome: { type: "string" }, status: { type: "string" }, orcamento_diario: { type: "number" }, orcamento_total: { type: "number" }, limite_gasto: { type: "number" }, data_fim: { type: "string" } }, required: ["campanha_id"] } },
      { name: "atualizar_conjunto_anuncios", description: "Atualiza um conjunto de anúncios", inputSchema: { type: "object", properties: { conjunto_id: { type: "string" }, nome: { type: "string" }, status: { type: "string" }, orcamento_diario: { type: "number" }, orcamento_total: { type: "number" }, data_fim: { type: "string" }, bid_amount: { type: "number" } }, required: ["conjunto_id"] } },
      { name: "atualizar_anuncio", description: "Atualiza o status ou nome de um anúncio", inputSchema: { type: "object", properties: { anuncio_id: { type: "string" }, nome: { type: "string" }, status: { type: "string" } }, required: ["anuncio_id"] } },
      { name: "duplicar_campanha", description: "Duplica uma campanha para a mesma ou outra conta", inputSchema: { type: "object", properties: { campanha_id: { type: "string" }, conta_destino: { type: "string" }, novo_nome: { type: "string" }, status_inicial: { type: "string", default: "PAUSED" } }, required: ["campanha_id"] } },
      { name: "pesquisar_interesses", description: "Pesquisa interesses para targeting", inputSchema: { type: "object", properties: { termo: { type: "string" }, locale: { type: "string", default: "pt_PT" } }, required: ["termo"] } },
      { name: "estimar_alcance", description: "Estima o alcance potencial de um targeting", inputSchema: { type: "object", properties: { conta_id: { type: "string" }, paises: { type: "array", items: { type: "string" } }, idade_min: { type: "number", default: 18 }, idade_max: { type: "number", default: 65 }, genero: { type: "array", items: { type: "number" } }, interesses: { type: "array", items: { type: "object" } }, publicos_custom: { type: "array", items: { type: "string" } }, orcamento_diario: { type: "number" }, objetivo_otimizacao: { type: "string" } }, required: ["conta_id", "paises"] } },
    ],
  }));

  // ── Execução ─────────────────────────────────────────────────────────────────
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    // LEITURA
    if (name === "listar_contas") {
      const [ownedData, clientData] = await Promise.all([
        metaGetAll(`${META_BUSINESS_ID}/owned_ad_accounts`, { fields: "id,name,account_status,currency,amount_spent,balance,timezone_name" }),
        metaGetAll(`${META_BUSINESS_ID}/client_ad_accounts`, { fields: "id,name,account_status,currency,amount_spent,balance,timezone_name" }),
      ]);
      const owned  = ownedData.data  || [];
      const client = clientData.data || [];
      const todas  = Object.values([...owned, ...client].reduce((acc, c) => { acc[c.id] = c; return acc; }, {}));
      return { content: [{ type: "text", text: JSON.stringify({ data: todas, total: todas.length, owned: owned.length, client: client.length }, null, 2) }] };
    }

    if (name === "listar_campanhas") {
      const { conta_id, status = "ALL" } = args;
      const params = { fields: "id,name,status,objective,daily_budget,lifetime_budget,start_time,stop_time,buying_type,bid_strategy,spend_cap" };
      if (status !== "ALL") params.effective_status = JSON.stringify([status]);
      const data = await metaGetAll(`${conta_id}/campaigns`, params);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }

    if (name === "listar_conjuntos_anuncios") {
      const { campanha_id, status = "ALL" } = args;
      const params = { fields: "id,name,status,daily_budget,lifetime_budget,targeting,optimization_goal,billing_event,bid_amount,start_time,end_time,promoted_object" };
      if (status !== "ALL") params.effective_status = JSON.stringify([status]);
      const data = await metaGetAll(`${campanha_id}/adsets`, params);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }

    if (name === "listar_anuncios") {
      const { id } = args;
      const data = await metaGetAll(`${id}/ads`, { fields: "id,name,status,creative{id,name,title,body,image_url},adset_id,campaign_id" });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }

    if (name === "listar_publicos") {
      const { conta_id } = args;
      const data = await metaGetAll(`${conta_id}/customaudiences`, { fields: "id,name,description,subtype,approximate_count_lower_bound,approximate_count_upper_bound,time_created" });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }

    if (name === "listar_paginas") {
      const data = await metaGetAll(`${META_BUSINESS_ID}/owned_pages`, { fields: "id,name,category,fan_count,picture" });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }

    if (name === "listar_pixels") {
      const data = await metaGetAll(`${META_BUSINESS_ID}/owned_pixels`, { fields: "id,name,creation_time,last_fired_time,is_unavailable" });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }

    if (name === "listar_imagens") {
      const { conta_id } = args;
      const data = await metaGetAll(`${conta_id}/adimages`, { fields: "hash,name,url,url_128,width,height,created_time" });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }

    if (name === "metricas_campanha") {
      const { campanha_id, periodo = "last_30d" } = args;
      const data = await metaGet(`${campanha_id}/insights`, { fields: "campaign_name,impressions,clicks,spend,reach,frequency,cpc,cpm,ctr,actions,cost_per_action_type,purchase_roas", date_preset: periodo });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }

    if (name === "resumo_conta") {
      const { conta_id, periodo = "last_30d" } = args;
      const data = await metaGet(`${conta_id}/insights`, { fields: "account_name,impressions,clicks,spend,reach,frequency,cpc,cpm,ctr,actions,cost_per_action_type,purchase_roas", date_preset: periodo, level: "account" });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }

    if (name === "resumo_todos_clientes") {
      const { periodo = "last_30d" } = args;
      const [ownedData, clientData] = await Promise.all([
        metaGetAll(`${META_BUSINESS_ID}/owned_ad_accounts`, { fields: "id,name,account_status" }),
        metaGetAll(`${META_BUSINESS_ID}/client_ad_accounts`, { fields: "id,name,account_status" }),
      ]);
      const todas = Object.values([...(ownedData.data || []), ...(clientData.data || [])].reduce((acc, c) => { acc[c.id] = c; return acc; }, {}));
      const resultados = [];
      for (const conta of todas) {
        if (conta.account_status !== 1) continue;
        const insights = await metaGet(`${conta.id}/insights`, { fields: "account_name,impressions,clicks,spend,reach,cpc,cpm,ctr,actions,purchase_roas", date_preset: periodo, level: "account" });
        resultados.push({ conta: conta.name, id: conta.id, insights: insights.data || [] });
      }
      return { content: [{ type: "text", text: JSON.stringify(resultados, null, 2) }] };
    }

    if (name === "metricas_conta_por_campanha") {
      const { conta_id, periodo = "last_30d" } = args;
      const data = await metaGet(`${conta_id}/insights`, { fields: "campaign_name,campaign_id,impressions,clicks,spend,reach,frequency,cpc,cpm,ctr,actions,cost_per_action_type,purchase_roas", date_preset: periodo, level: "campaign", limit: "200" });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }

    // CRIAÇÃO
    if (name === "criar_campanha") {
      const { conta_id, nome, objetivo, status = "PAUSED", orcamento_diario, orcamento_total, data_inicio, data_fim, limite_gasto, bid_strategy, special_ad_categories = [] } = args;
      const body = { name: nome, objective: objetivo, status, special_ad_categories };
      if (orcamento_diario) body.daily_budget    = String(orcamento_diario);
      if (orcamento_total)  body.lifetime_budget  = String(orcamento_total);
      if (limite_gasto)     body.spend_cap        = String(limite_gasto);
      if (bid_strategy)     body.bid_strategy     = bid_strategy;
      if (data_inicio)      body.start_time       = data_inicio;
      if (data_fim)         body.stop_time        = data_fim;
      const data = await metaPost(`${conta_id}/campaigns`, body);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }

    if (name === "criar_conjunto_anuncios") {
      const { conta_id, campanha_id, nome, status = "PAUSED", orcamento_diario, orcamento_total, data_inicio, data_fim, objetivo_otimizacao, evento_cobranca, pixel_id, evento_conversao, paises = [], idade_min = 18, idade_max = 65, genero = [], interesses = [], publicos_incluir = [], publicos_excluir = [], placements_automaticos = true, placements_manuais, bid_amount } = args;
      const targeting = { age_min: idade_min, age_max: idade_max, geo_locations: { countries: paises } };
      if (genero.length > 0)          targeting.genders                    = genero;
      if (interesses.length > 0)      targeting.interests                  = interesses;
      if (publicos_incluir.length > 0) targeting.custom_audiences           = publicos_incluir.map(id => ({ id }));
      if (publicos_excluir.length > 0) targeting.excluded_custom_audiences  = publicos_excluir.map(id => ({ id }));
      if (placements_automaticos) {
        targeting.publisher_platforms = ["facebook", "instagram", "audience_network", "messenger"];
        targeting.facebook_positions  = ["feed", "right_hand_column", "marketplace", "video_feeds", "story", "search", "reels"];
        targeting.instagram_positions = ["stream", "story", "explore", "reels", "profile_feed"];
      } else if (placements_manuais) {
        Object.assign(targeting, placements_manuais);
      }
      const body = { name: nome, campaign_id: campanha_id, status, optimization_goal: objetivo_otimizacao, billing_event: evento_cobranca, targeting };
      if (orcamento_diario) body.daily_budget   = String(orcamento_diario);
      if (orcamento_total)  body.lifetime_budget = String(orcamento_total);
      if (data_inicio)      body.start_time      = data_inicio;
      if (data_fim)         body.end_time        = data_fim;
      if (bid_amount)       body.bid_amount      = String(bid_amount);
      if (pixel_id && evento_conversao) body.promoted_object = { pixel_id, custom_event_type: evento_conversao };
      else if (pixel_id)                body.promoted_object = { pixel_id };
      const data = await metaPost(`${conta_id}/adsets`, body);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }

    if (name === "criar_criativo") {
      const { conta_id, nome, pagina_id, instagram_id, titulo, corpo, descricao, url_destino, url_display, cta, imagem_hash, video_id, formato = "SINGLE_IMAGE", carousel_cards = [], url_parametros } = args;
      const object_story_spec = { page_id: pagina_id };
      if (instagram_id) object_story_spec.instagram_actor_id = instagram_id;
      if (formato === "CAROUSEL") {
        object_story_spec.link_data = { link: url_destino, child_attachments: carousel_cards.map(card => ({ link: card.url_destino, name: card.titulo, description: card.descricao, image_hash: card.imagem_hash, call_to_action: { type: card.cta || cta, value: { link: card.url_destino } } })), call_to_action: { type: cta, value: { link: url_destino } } };
      } else if (formato === "SINGLE_VIDEO" && video_id) {
        const video_data = { video_id, title: titulo, message: corpo, description: descricao, call_to_action: { type: cta, value: { link: url_destino } } };
        if (url_parametros) video_data.url_tags = url_parametros;
        object_story_spec.video_data = video_data;
      } else {
        const link_data = { link: url_destino, message: corpo, name: titulo, description: descricao, call_to_action: { type: cta, value: { link: url_destino } } };
        if (imagem_hash)    link_data.image_hash  = imagem_hash;
        if (url_display)    link_data.display_url  = url_display;
        if (url_parametros) link_data.url_tags     = url_parametros;
        object_story_spec.link_data = link_data;
      }
      const data = await metaPost(`${conta_id}/adcreatives`, { name: nome, object_story_spec });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }

    if (name === "criar_anuncio") {
      const { conta_id, conjunto_id, nome, criativo_id, status = "PAUSED" } = args;
      const data = await metaPost(`${conta_id}/ads`, { name: nome, adset_id: conjunto_id, creative: { creative_id: criativo_id }, status });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }

    if (name === "fazer_upload_imagem") {
      const { conta_id, url_imagem } = args;
      const data = await metaPost(`${conta_id}/adimages`, { url: url_imagem });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }

    if (name === "criar_publico_personalizado") {
      const { conta_id, nome, descricao, tipo, pixel_id, regras_website, retencao_dias = 30, engagement_tipo, engagement_id } = args;
      const body = { name: nome, subtype: tipo };
      if (descricao) body.description = descricao;
      if (tipo === "WEBSITE" && pixel_id) {
        body.pixel_id = pixel_id;
        body.retention_days = retencao_dias;
        body.rule = JSON.stringify(regras_website || { inclusions: { operator: "or", rules: [{ event_sources: [{ id: pixel_id, type: "pixel" }], retention_seconds: retencao_dias * 86400, filter: { operator: "and", filters: [{ field: "event", operator: "eq", value: "PageView" }] } }] } });
      }
      if (tipo === "ENGAGEMENT") {
        body.engagement_specs = [{ action_type: engagement_tipo, id: engagement_id }];
        body.retention_days   = retencao_dias;
      }
      const data = await metaPost(`${conta_id}/customaudiences`, body);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }

    if (name === "criar_publico_semelhante") {
      const { conta_id, publico_origem_id, paises, tamanho = 1, nome } = args;
      const data = await metaPost(`${conta_id}/customaudiences`, { name: nome, origin_audience_id: publico_origem_id, subtype: "LOOKALIKE", lookalike_spec: JSON.stringify({ type: "similarity", ratio: tamanho / 100, countries: paises }) });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }

    // GESTÃO
    if (name === "atualizar_campanha") {
      const { campanha_id, nome, status, orcamento_diario, orcamento_total, limite_gasto, data_fim } = args;
      const body = {};
      if (nome)             body.name            = nome;
      if (status)           body.status          = status;
      if (orcamento_diario) body.daily_budget     = String(orcamento_diario);
      if (orcamento_total)  body.lifetime_budget  = String(orcamento_total);
      if (limite_gasto)     body.spend_cap        = String(limite_gasto);
      if (data_fim)         body.stop_time        = data_fim;
      const data = await metaPost(`${campanha_id}`, body);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }

    if (name === "atualizar_conjunto_anuncios") {
      const { conjunto_id, nome, status, orcamento_diario, orcamento_total, data_fim, bid_amount } = args;
      const body = {};
      if (nome)             body.name            = nome;
      if (status)           body.status          = status;
      if (orcamento_diario) body.daily_budget     = String(orcamento_diario);
      if (orcamento_total)  body.lifetime_budget  = String(orcamento_total);
      if (data_fim)         body.end_time         = data_fim;
      if (bid_amount)       body.bid_amount       = String(bid_amount);
      const data = await metaPost(`${conjunto_id}`, body);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }

    if (name === "atualizar_anuncio") {
      const { anuncio_id, nome, status } = args;
      const body = {};
      if (nome)   body.name   = nome;
      if (status) body.status = status;
      const data = await metaPost(`${anuncio_id}`, body);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }

    if (name === "duplicar_campanha") {
      const { campanha_id, conta_destino, novo_nome, status_inicial = "PAUSED" } = args;
      const body = { status: status_inicial };
      if (conta_destino) body.account_id = conta_destino.replace("act_", "");
      if (novo_nome)     body.name       = novo_nome;
      const data = await metaPost(`${campanha_id}/copies`, body);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }

    if (name === "pesquisar_interesses") {
      const { termo, locale = "pt_PT" } = args;
      const data = await metaGet("search", { type: "adinterest", q: termo, locale, fields: "id,name,audience_size_lower_bound,audience_size_upper_bound,path,description,topic", limit: "30" });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }

    if (name === "estimar_alcance") {
      const { conta_id, paises, idade_min = 18, idade_max = 65, genero = [], interesses = [], publicos_custom = [], orcamento_diario, objetivo_otimizacao } = args;
      const targeting_spec = { age_min: idade_min, age_max: idade_max, geo_locations: { countries: paises } };
      if (genero.length > 0)          targeting_spec.genders          = genero;
      if (interesses.length > 0)      targeting_spec.interests        = interesses;
      if (publicos_custom.length > 0) targeting_spec.custom_audiences = publicos_custom.map(id => ({ id }));
      const params = { targeting_spec: JSON.stringify(targeting_spec), optimize_for: objetivo_otimizacao || "LINK_CLICKS" };
      if (orcamento_diario) params.daily_budget = String(orcamento_diario);
      const data = await metaGet(`${conta_id}/reachestimate`, params);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }

    return { content: [{ type: "text", text: `Ferramenta '${name}' não encontrada` }] };
  });

  return server;
}

// ─── Servidor HTTP com SSE ────────────────────────────────────────────────────
const transports = new Map(); // sessão → transport

const httpServer = http.createServer(async (req, res) => {
  const reqUrl = new URL(req.url, `http://localhost:${PORT}`);

  // Health check
  if (reqUrl.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", version: "2.0.0", server: "meta-ads-escala" }));
    return;
  }

  // Validação de secret (opcional)
  if (API_SECRET) {
    const token = req.headers["x-api-key"] || reqUrl.searchParams.get("api_key");
    if (token !== API_SECRET) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }
  }

  // SSE endpoint — o Claude conecta aqui
  if (reqUrl.pathname === "/sse" && req.method === "GET") {
    res.writeHead(200, {
      "Content-Type":  "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection":    "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });

    const server    = createMcpServer();
    const transport = new SSEServerTransport("/message", res);
    const sessionId = transport.sessionId;
    transports.set(sessionId, transport);

    req.on("close", () => {
      transports.delete(sessionId);
    });

    await server.connect(transport);
    return;
  }

  // POST endpoint — mensagens do Claude
  if (reqUrl.pathname === "/message" && req.method === "POST") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    const sessionId = reqUrl.searchParams.get("sessionId");
    const transport = transports.get(sessionId);

    if (!transport) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Session not found" }));
      return;
    }

    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end",  async () => {
      try {
        await transport.handlePostMessage(req, res, JSON.parse(body));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, x-api-key" });
    res.end();
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found" }));
});

httpServer.listen(PORT, () => {
  process.stdout.write(`[meta-ads-escala] Servidor HTTP/SSE a correr na porta ${PORT}\n`);
  process.stdout.write(`[meta-ads-escala] SSE endpoint: http://localhost:${PORT}/sse\n`);
  process.stdout.write(`[meta-ads-escala] Health check: http://localhost:${PORT}/health\n`);
});
