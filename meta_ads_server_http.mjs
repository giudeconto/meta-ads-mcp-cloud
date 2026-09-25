#!/usr/bin/env node
/**
 * Servidor MCP - Meta Ads para Escala Ads
 * Versão Streamable HTTP — compatível com Claude.ai remote connectors
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import express from "express";
import { randomUUID, createHash } from "crypto";

// ─── Configuração ─────────────────────────────────────────────────────────────
const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN || "";
const META_BUSINESS_ID  = process.env.META_BUSINESS_ID  || "";
const APPROVAL_CODE     = process.env.APPROVAL_CODE || "";
const PORT              = process.env.PORT || 3000;
const API_VERSION       = "v20.0";
const BASE_URL          = `https://graph.facebook.com/${API_VERSION}`;

if (!META_ACCESS_TOKEN) process.stderr.write("[meta-ads-escala] ERRO: META_ACCESS_TOKEN não definido.\n");
if (!META_BUSINESS_ID)  process.stderr.write("[meta-ads-escala] ERRO: META_BUSINESS_ID não definido.\n");
if (!APPROVAL_CODE)     process.stderr.write("[meta-ads-escala] AVISO: APPROVAL_CODE não definido — ativação de campanhas ficará bloqueada até ser configurado.\n");

// ─── Helpers Meta API ─────────────────────────────────────────────────────────
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
    process.stderr.write(`[meta-ads-escala] Erro fetch: ${e.message}\n`);
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
    const next       = new URL(data.paging.next);
    const nextParams = Object.fromEntries(next.searchParams.entries());
    data = await metaGet(endpoint, nextParams);
    if (data.error) break;
    results.push(...(data.data || []));
  }
  return { data: results };
}

// ─── Hashing de dados de clientes (públicos de lista) ─────────────────────────
// A Meta exige que e-mails e telefones cheguem já em SHA-256 — nunca em texto
// simples. Normalizamos exatamente como a Meta pede antes de fazer o hash:
// e-mail em minúsculas e sem espaços; telefone só com dígitos (com indicativo
// do país, sem "+", sem espaços/traços).
function normalizarEmail(email) {
  return String(email).trim().toLowerCase();
}
function normalizarTelefone(tel) {
  return String(tel).replace(/[^0-9]/g, "");
}
function hashSha256(valor) {
  return createHash("sha256").update(valor, "utf8").digest("hex");
}

// ─── Aprovação de ativação ────────────────────────────────────────────────────
// Bloqueia qualquer mudança de status para ACTIVE que não venha com o código de
// aprovação correto. Retorna uma mensagem de erro (string) se bloqueado, ou null se liberado.
function bloqueiaAtivacaoSemCodigo(status, codigo_aprovacao) {
  if (status !== "ACTIVE") return null;
  if (!APPROVAL_CODE) return "Ativação bloqueada: APPROVAL_CODE não está configurado no servidor.";
  if (codigo_aprovacao !== APPROVAL_CODE) return "Ativação bloqueada: código de aprovação em falta ou inválido. Peça a aprovação a quem gere a conta (use 'aprovar_e_ativar').";
  return null;
}

// ─── Factory MCP ──────────────────────────────────────────────────────────────
function createMcpServer() {
  const server = new Server(
    { name: "meta-ads-escala", version: "2.0.0" },
    { capabilities: { tools: {} } }
  );

  // ── Ferramentas ───────────────────────────────────────────────────────────
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      // LEITURA
      { name: "listar_contas", description: "Lista todas as contas de anúncios do Business Manager", inputSchema: { type: "object", properties: {}, required: [] } },
      { name: "listar_campanhas", description: "Lista as campanhas de uma conta", inputSchema: { type: "object", properties: { conta_id: { type: "string" }, status: { type: "string", default: "ALL" } }, required: ["conta_id"] } },
      { name: "listar_conjuntos_anuncios", description: "Lista os conjuntos de anúncios de uma campanha", inputSchema: { type: "object", properties: { campanha_id: { type: "string" }, status: { type: "string", default: "ALL" } }, required: ["campanha_id"] } },
      { name: "listar_anuncios", description: "Lista os anúncios de um conjunto ou campanha", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
      { name: "listar_publicos", description: "Lista os públicos personalizados da conta", inputSchema: { type: "object", properties: { conta_id: { type: "string" } }, required: ["conta_id"] } },
      { name: "listar_paginas", description: "Lista as páginas do Facebook no Business Manager", inputSchema: { type: "object", properties: {}, required: [] } },
      { name: "listar_pixels", description: "Lista os pixels Meta do Business Manager", inputSchema: { type: "object", properties: {}, required: [] } },
      { name: "listar_imagens", description: "Lista as imagens da biblioteca da conta", inputSchema: { type: "object", properties: { conta_id: { type: "string" } }, required: ["conta_id"] } },
      { name: "metricas_campanha", description: "Métricas de uma campanha", inputSchema: { type: "object", properties: { campanha_id: { type: "string" }, periodo: { type: "string", default: "last_30d" } }, required: ["campanha_id"] } },
      { name: "resumo_conta", description: "Resumo de performance de uma conta", inputSchema: { type: "object", properties: { conta_id: { type: "string" }, periodo: { type: "string", default: "last_30d" } }, required: ["conta_id"] } },
      { name: "resumo_todos_clientes", description: "Resumo de TODAS as contas ativas", inputSchema: { type: "object", properties: { periodo: { type: "string", default: "last_30d" } }, required: [] } },
      { name: "metricas_conta_por_campanha", description: "Métricas por campanha dentro de uma conta", inputSchema: { type: "object", properties: { conta_id: { type: "string" }, periodo: { type: "string", default: "last_30d" } }, required: ["conta_id"] } },
      // CRIAÇÃO
      { name: "criar_campanha", description: "Cria uma nova campanha. É SEMPRE criada em PAUSED, independentemente do que for pedido — precisa de aprovação via 'aprovar_e_ativar' para ficar ativa.", inputSchema: { type: "object", properties: { conta_id: { type: "string" }, nome: { type: "string" }, objetivo: { type: "string", description: "OUTCOME_AWARENESS | OUTCOME_TRAFFIC | OUTCOME_ENGAGEMENT | OUTCOME_LEADS | OUTCOME_APP_PROMOTION | OUTCOME_SALES" }, orcamento_diario: { type: "number" }, orcamento_total: { type: "number" }, data_inicio: { type: "string" }, data_fim: { type: "string" }, limite_gasto: { type: "number" }, bid_strategy: { type: "string" }, special_ad_categories: { type: "array", items: { type: "string" } } }, required: ["conta_id", "nome", "objetivo"] } },
      { name: "criar_conjunto_anuncios", description: "Cria um conjunto de anúncios. É SEMPRE criado em PAUSED, independentemente do que for pedido — precisa de aprovação via 'aprovar_e_ativar' para ficar ativo.", inputSchema: { type: "object", properties: { conta_id: { type: "string" }, campanha_id: { type: "string" }, nome: { type: "string" }, orcamento_diario: { type: "number" }, orcamento_total: { type: "number" }, data_inicio: { type: "string" }, data_fim: { type: "string" }, objetivo_otimizacao: { type: "string" }, evento_cobranca: { type: "string" }, pixel_id: { type: "string" }, evento_conversao: { type: "string" }, paises: { type: "array", items: { type: "string" } }, idade_min: { type: "number", default: 18 }, idade_max: { type: "number", default: 65 }, genero: { type: "array", items: { type: "number" } }, interesses: { type: "array", items: { type: "object" } }, publicos_incluir: { type: "array", items: { type: "string" } }, publicos_excluir: { type: "array", items: { type: "string" } }, placements_automaticos: { type: "boolean", default: true }, publico_advantage: { type: "boolean", default: true, description: "true = deixa a Meta expandir o público automaticamente (Advantage+ audience) | false = usa só o targeting definido, sem expansão" }, bid_amount: { type: "number" } }, required: ["conta_id", "campanha_id", "nome", "objetivo_otimizacao", "evento_cobranca"] } },
      { name: "criar_criativo", description: "Cria um criativo de anúncio", inputSchema: { type: "object", properties: { conta_id: { type: "string" }, nome: { type: "string" }, pagina_id: { type: "string" }, instagram_id: { type: "string" }, titulo: { type: "string" }, corpo: { type: "string" }, descricao: { type: "string" }, url_destino: { type: "string" }, cta: { type: "string", description: "LEARN_MORE | SHOP_NOW | SIGN_UP | DOWNLOAD | GET_QUOTE | CONTACT_US | SEND_MESSAGE | WHATSAPP_MESSAGE" }, imagem_hash: { type: "string" }, video_id: { type: "string" }, formato: { type: "string", default: "SINGLE_IMAGE" }, carousel_cards: { type: "array", items: { type: "object" } }, url_parametros: { type: "string" } }, required: ["conta_id", "nome", "pagina_id", "corpo", "url_destino", "cta"] } },
      { name: "criar_anuncio", description: "Cria um anúncio associando criativo a um conjunto. É SEMPRE criado em PAUSED, independentemente do que for pedido — precisa de aprovação via 'aprovar_e_ativar' para ficar ativo.", inputSchema: { type: "object", properties: { conta_id: { type: "string" }, conjunto_id: { type: "string" }, nome: { type: "string" }, criativo_id: { type: "string" } }, required: ["conta_id", "conjunto_id", "nome", "criativo_id"] } },
      { name: "fazer_upload_imagem", description: "Upload de imagem via URL", inputSchema: { type: "object", properties: { conta_id: { type: "string" }, url_imagem: { type: "string" } }, required: ["conta_id", "url_imagem"] } },
      { name: "fazer_upload_video", description: "Upload de vídeo via URL para a biblioteca de vídeos da conta. O processamento na Meta é assíncrono — pode ser preciso aguardar antes do video_id ficar pronto para uso num criativo.", inputSchema: { type: "object", properties: { conta_id: { type: "string" }, url_video: { type: "string" }, nome: { type: "string" } }, required: ["conta_id", "url_video"] } },
      { name: "verificar_status_video", description: "Verifica se um vídeo já terminou de processar e está pronto para ser usado num criativo", inputSchema: { type: "object", properties: { video_id: { type: "string" } }, required: ["video_id"] } },
      { name: "criar_publico_personalizado", description: "Cria um público personalizado. Para tipo=CUSTOMER_LIST, depois de criado usa 'adicionar_pessoas_publico' para carregar os contactos.", inputSchema: { type: "object", properties: { conta_id: { type: "string" }, nome: { type: "string" }, descricao: { type: "string" }, tipo: { type: "string", description: "WEBSITE | CUSTOMER_LIST | ENGAGEMENT" }, pixel_id: { type: "string" }, retencao_dias: { type: "number", default: 30 }, engagement_tipo: { type: "string" }, engagement_id: { type: "string" }, customer_file_source: { type: "string", default: "USER_PROVIDED_ONLY", description: "Só para tipo=CUSTOMER_LIST: USER_PROVIDED_ONLY | PARTNER_PROVIDED_ONLY | BOTH_USER_AND_PARTNER_PROVIDED" } }, required: ["conta_id", "nome", "tipo"] } },
      { name: "adicionar_pessoas_publico", description: "Carrega contactos (emails e/ou telefones) para um público de lista de clientes (CUSTOMER_LIST) já criado. Os dados são normalizados e convertidos em hash SHA-256 aqui no servidor antes de seguirem para a Meta — nunca envies nem recebas de volta os dados em texto simples.", inputSchema: { type: "object", properties: { publico_id: { type: "string" }, emails: { type: "array", items: { type: "string" } }, telefones: { type: "array", items: { type: "string" } } }, required: ["publico_id"] } },
      { name: "criar_publico_semelhante", description: "Cria um público Lookalike", inputSchema: { type: "object", properties: { conta_id: { type: "string" }, publico_origem_id: { type: "string" }, paises: { type: "array", items: { type: "string" } }, tamanho: { type: "number", default: 1 }, nome: { type: "string" } }, required: ["conta_id", "publico_origem_id", "paises", "nome"] } },
      // GESTÃO
      { name: "atualizar_campanha", description: "Atualiza uma campanha. Para mudar o status para ACTIVE é necessário fornecer codigo_aprovacao — caso contrário use 'aprovar_e_ativar'.", inputSchema: { type: "object", properties: { campanha_id: { type: "string" }, nome: { type: "string" }, status: { type: "string" }, codigo_aprovacao: { type: "string" }, orcamento_diario: { type: "number" }, orcamento_total: { type: "number" }, limite_gasto: { type: "number" }, data_fim: { type: "string" } }, required: ["campanha_id"] } },
      { name: "atualizar_conjunto_anuncios", description: "Atualiza um conjunto de anúncios. Para mudar o status para ACTIVE é necessário fornecer codigo_aprovacao — caso contrário use 'aprovar_e_ativar'.", inputSchema: { type: "object", properties: { conjunto_id: { type: "string" }, nome: { type: "string" }, status: { type: "string" }, codigo_aprovacao: { type: "string" }, orcamento_diario: { type: "number" }, orcamento_total: { type: "number" }, data_fim: { type: "string" }, bid_amount: { type: "number" } }, required: ["conjunto_id"] } },
      { name: "atualizar_anuncio", description: "Atualiza um anúncio. Para mudar o status para ACTIVE é necessário fornecer codigo_aprovacao — caso contrário use 'aprovar_e_ativar'.", inputSchema: { type: "object", properties: { anuncio_id: { type: "string" }, nome: { type: "string" }, status: { type: "string" }, codigo_aprovacao: { type: "string" } }, required: ["anuncio_id"] } },
      { name: "aprovar_e_ativar", description: "Aprova e ativa (PAUSED → ACTIVE) uma campanha, conjunto de anúncios ou anúncio. Requer o código de aprovação interno da agência.", inputSchema: { type: "object", properties: { nivel: { type: "string", description: "campanha | conjunto | anuncio" }, id: { type: "string" }, codigo_aprovacao: { type: "string" } }, required: ["nivel", "id", "codigo_aprovacao"] } },
      { name: "duplicar_campanha", description: "Duplica uma campanha. Para duplicar já em ACTIVE é necessário fornecer codigo_aprovacao.", inputSchema: { type: "object", properties: { campanha_id: { type: "string" }, conta_destino: { type: "string" }, novo_nome: { type: "string" }, status_inicial: { type: "string", default: "PAUSED" }, codigo_aprovacao: { type: "string" } }, required: ["campanha_id"] } },
      { name: "pesquisar_interesses", description: "Pesquisa interesses para targeting", inputSchema: { type: "object", properties: { termo: { type: "string" }, locale: { type: "string", default: "pt_PT" } }, required: ["termo"] } },
      { name: "estimar_alcance", description: "Estima o alcance de um targeting", inputSchema: { type: "object", properties: { conta_id: { type: "string" }, paises: { type: "array", items: { type: "string" } }, idade_min: { type: "number", default: 18 }, idade_max: { type: "number", default: 65 }, genero: { type: "array", items: { type: "number" } }, interesses: { type: "array", items: { type: "object" } }, publicos_custom: { type: "array", items: { type: "string" } }, orcamento_diario: { type: "number" }, objetivo_otimizacao: { type: "string" } }, required: ["conta_id", "paises"] } },
    ],
  }));

  // ── Execução ──────────────────────────────────────────────────────────────
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    if (name === "listar_contas") {
      const [o, c] = await Promise.all([
        metaGetAll(`${META_BUSINESS_ID}/owned_ad_accounts`,  { fields: "id,name,account_status,currency,amount_spent,balance,timezone_name" }),
        metaGetAll(`${META_BUSINESS_ID}/client_ad_accounts`, { fields: "id,name,account_status,currency,amount_spent,balance,timezone_name" }),
      ]);
      const todas = Object.values([...(o.data || []), ...(c.data || [])].reduce((a, x) => { a[x.id] = x; return a; }, {}));
      return { content: [{ type: "text", text: JSON.stringify({ data: todas, total: todas.length }, null, 2) }] };
    }
    if (name === "listar_campanhas") {
      const { conta_id, status = "ALL" } = args;
      const p = { fields: "id,name,status,objective,daily_budget,lifetime_budget,start_time,stop_time,bid_strategy,spend_cap" };
      if (status !== "ALL") p.effective_status = JSON.stringify([status]);
      return { content: [{ type: "text", text: JSON.stringify(await metaGetAll(`${conta_id}/campaigns`, p), null, 2) }] };
    }
    if (name === "listar_conjuntos_anuncios") {
      const { campanha_id, status = "ALL" } = args;
      const p = { fields: "id,name,status,daily_budget,lifetime_budget,targeting,optimization_goal,billing_event,bid_amount,start_time,end_time,promoted_object" };
      if (status !== "ALL") p.effective_status = JSON.stringify([status]);
      return { content: [{ type: "text", text: JSON.stringify(await metaGetAll(`${campanha_id}/adsets`, p), null, 2) }] };
    }
    if (name === "listar_anuncios") {
      const { id } = args;
      return { content: [{ type: "text", text: JSON.stringify(await metaGetAll(`${id}/ads`, { fields: "id,name,status,creative{id,name,title,body,image_url},adset_id,campaign_id" }), null, 2) }] };
    }
    if (name === "listar_publicos") {
      const { conta_id } = args;
      return { content: [{ type: "text", text: JSON.stringify(await metaGetAll(`${conta_id}/customaudiences`, { fields: "id,name,description,subtype,approximate_count_lower_bound,approximate_count_upper_bound,time_created" }), null, 2) }] };
    }
    if (name === "listar_paginas") {
      return { content: [{ type: "text", text: JSON.stringify(await metaGetAll(`${META_BUSINESS_ID}/owned_pages`, { fields: "id,name,category,fan_count" }), null, 2) }] };
    }
    if (name === "listar_pixels") {
      return { content: [{ type: "text", text: JSON.stringify(await metaGetAll(`${META_BUSINESS_ID}/owned_pixels`, { fields: "id,name,creation_time,last_fired_time" }), null, 2) }] };
    }
    if (name === "listar_imagens") {
      const { conta_id } = args;
      return { content: [{ type: "text", text: JSON.stringify(await metaGetAll(`${conta_id}/adimages`, { fields: "hash,name,url,url_128,width,height,created_time" }), null, 2) }] };
    }
    if (name === "metricas_campanha") {
      const { campanha_id, periodo = "last_30d" } = args;
      return { content: [{ type: "text", text: JSON.stringify(await metaGet(`${campanha_id}/insights`, { fields: "campaign_name,impressions,clicks,spend,reach,frequency,cpc,cpm,ctr,actions,cost_per_action_type,purchase_roas", date_preset: periodo }), null, 2) }] };
    }
    if (name === "resumo_conta") {
      const { conta_id, periodo = "last_30d" } = args;
      return { content: [{ type: "text", text: JSON.stringify(await metaGet(`${conta_id}/insights`, { fields: "account_name,impressions,clicks,spend,reach,frequency,cpc,cpm,ctr,actions,cost_per_action_type,purchase_roas", date_preset: periodo, level: "account" }), null, 2) }] };
    }
    if (name === "resumo_todos_clientes") {
      const { periodo = "last_30d" } = args;
      const [o, c] = await Promise.all([
        metaGetAll(`${META_BUSINESS_ID}/owned_ad_accounts`,  { fields: "id,name,account_status" }),
        metaGetAll(`${META_BUSINESS_ID}/client_ad_accounts`, { fields: "id,name,account_status" }),
      ]);
      const todas = Object.values([...(o.data || []), ...(c.data || [])].reduce((a, x) => { a[x.id] = x; return a; }, {}));
      const res = [];
      for (const conta of todas) {
        if (conta.account_status !== 1) continue;
        const ins = await metaGet(`${conta.id}/insights`, { fields: "account_name,impressions,clicks,spend,reach,cpc,cpm,ctr,actions,purchase_roas", date_preset: periodo, level: "account" });
        res.push({ conta: conta.name, id: conta.id, insights: ins.data || [] });
      }
      return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
    }
    if (name === "metricas_conta_por_campanha") {
      const { conta_id, periodo = "last_30d" } = args;
      return { content: [{ type: "text", text: JSON.stringify(await metaGet(`${conta_id}/insights`, { fields: "campaign_name,campaign_id,impressions,clicks,spend,reach,frequency,cpc,cpm,ctr,actions,cost_per_action_type,purchase_roas", date_preset: periodo, level: "campaign", limit: "200" }), null, 2) }] };
    }
    if (name === "criar_campanha") {
      const { conta_id, nome, objetivo, orcamento_diario, orcamento_total, data_inicio, data_fim, limite_gasto, bid_strategy, special_ad_categories = [] } = args;
      // Toda campanha nasce em PAUSED — ativação exige aprovação via 'aprovar_e_ativar'.
      const b = { name: nome, objective: objetivo, status: "PAUSED", special_ad_categories };
      if (orcamento_diario) b.daily_budget    = String(orcamento_diario);
      if (orcamento_total)  b.lifetime_budget = String(orcamento_total);
      if (limite_gasto)     b.spend_cap       = String(limite_gasto);
      if (bid_strategy)     b.bid_strategy    = bid_strategy;
      if (data_inicio)      b.start_time      = data_inicio;
      if (data_fim)         b.stop_time       = data_fim;
      return { content: [{ type: "text", text: JSON.stringify(await metaPost(`${conta_id}/campaigns`, b), null, 2) }] };
    }
    if (name === "criar_conjunto_anuncios") {
      const { conta_id, campanha_id, nome, orcamento_diario, orcamento_total, data_inicio, data_fim, objetivo_otimizacao, evento_cobranca, pixel_id, evento_conversao, paises = [], idade_min = 18, idade_max = 65, genero = [], interesses = [], publicos_incluir = [], publicos_excluir = [], placements_automaticos = true, publico_advantage = true, bid_amount } = args;
      const targeting = { age_min: idade_min, age_max: idade_max, geo_locations: { countries: paises } };
      targeting.targeting_automation = { advantage_audience: publico_advantage ? 1 : 0 };
      if (genero.length)           targeting.genders                   = genero;
      if (interesses.length)       targeting.interests                 = interesses;
      if (publicos_incluir.length) targeting.custom_audiences          = publicos_incluir.map(id => ({ id }));
      if (publicos_excluir.length) targeting.excluded_custom_audiences = publicos_excluir.map(id => ({ id }));
      if (!placements_automaticos) {
        // Só restringimos posicionamentos quando o pedido é explicitamente manual.
        // Com placements_automaticos=true (padrão), não enviamos publisher_platforms
        // nem facebook_positions/instagram_positions: deixar o campo de fora é o
        // sinal correto para a Meta escolher TODOS os posicionamentos elegíveis
        // automaticamente (Advantage+ placements), incluindo os que a Meta lançar
        // no futuro — evita ficarmos reféns de listas fixas que a Meta descontinua.
        targeting.publisher_platforms = ["facebook", "instagram", "audience_network", "messenger"];
        targeting.facebook_positions  = ["feed", "right_hand_column", "marketplace", "story", "search", "facebook_reels"];
        targeting.instagram_positions = ["stream", "story", "explore", "reels", "profile_feed"];
      }
      // Todo conjunto de anúncios nasce em PAUSED — ativação exige aprovação via 'aprovar_e_ativar'.
      const b = { name: nome, campaign_id: campanha_id, status: "PAUSED", optimization_goal: objetivo_otimizacao, billing_event: evento_cobranca, targeting };
      if (orcamento_diario) b.daily_budget   = String(orcamento_diario);
      if (orcamento_total)  b.lifetime_budget = String(orcamento_total);
      if (data_inicio)      b.start_time      = data_inicio;
      if (data_fim)         b.end_time        = data_fim;
      if (bid_amount)       b.bid_amount      = String(bid_amount);
      if (pixel_id && evento_conversao) b.promoted_object = { pixel_id, custom_event_type: evento_conversao };
      else if (pixel_id)                b.promoted_object = { pixel_id };
      return { content: [{ type: "text", text: JSON.stringify(await metaPost(`${conta_id}/adsets`, b), null, 2) }] };
    }
    if (name === "criar_criativo") {
      const { conta_id, nome, pagina_id, instagram_id, titulo, corpo, descricao, url_destino, cta, imagem_hash, video_id, formato = "SINGLE_IMAGE", carousel_cards = [], url_parametros } = args;
      const spec = { page_id: pagina_id };
      if (instagram_id) spec.instagram_actor_id = instagram_id;
      if (formato === "CAROUSEL") {
        spec.link_data = { link: url_destino, child_attachments: carousel_cards.map(card => ({ link: card.url_destino, name: card.titulo, description: card.descricao, image_hash: card.imagem_hash, call_to_action: { type: card.cta || cta, value: { link: card.url_destino } } })), call_to_action: { type: cta, value: { link: url_destino } } };
      } else if (formato === "SINGLE_VIDEO" && video_id) {
        const vd = { video_id, title: titulo, message: corpo, description: descricao, call_to_action: { type: cta, value: { link: url_destino } } };
        if (url_parametros) vd.url_tags = url_parametros;
        spec.video_data = vd;
      } else {
        const ld = { link: url_destino, message: corpo, name: titulo, description: descricao, call_to_action: { type: cta, value: { link: url_destino } } };
        if (imagem_hash)    ld.image_hash = imagem_hash;
        if (url_parametros) ld.url_tags   = url_parametros;
        spec.link_data = ld;
      }
      return { content: [{ type: "text", text: JSON.stringify(await metaPost(`${conta_id}/adcreatives`, { name: nome, object_story_spec: spec }), null, 2) }] };
    }
    if (name === "criar_anuncio") {
      const { conta_id, conjunto_id, nome, criativo_id } = args;
      // Todo anúncio nasce em PAUSED — ativação exige aprovação via 'aprovar_e_ativar'.
      return { content: [{ type: "text", text: JSON.stringify(await metaPost(`${conta_id}/ads`, { name: nome, adset_id: conjunto_id, creative: { creative_id: criativo_id }, status: "PAUSED" }), null, 2) }] };
    }
    if (name === "fazer_upload_imagem") {
      const { conta_id, url_imagem } = args;
      return { content: [{ type: "text", text: JSON.stringify(await metaPost(`${conta_id}/adimages`, { url: url_imagem }), null, 2) }] };
    }
    if (name === "fazer_upload_video") {
      const { conta_id, url_video, nome } = args;
      const b = { file_url: url_video };
      if (nome) { b.name = nome; b.title = nome; }
      return { content: [{ type: "text", text: JSON.stringify(await metaPost(`${conta_id}/advideos`, b), null, 2) }] };
    }
    if (name === "verificar_status_video") {
      const { video_id } = args;
      return { content: [{ type: "text", text: JSON.stringify(await metaGet(`${video_id}`, { fields: "id,title,status" }), null, 2) }] };
    }
    if (name === "criar_publico_personalizado") {
      const { conta_id, nome, descricao, tipo, pixel_id, retencao_dias = 30, engagement_tipo, engagement_id, customer_file_source } = args;
      const b = { name: nome };
      if (descricao) b.description = descricao;
      if (tipo === "WEBSITE" && pixel_id) {
        b.pixel_id = pixel_id; b.retention_days = retencao_dias;
        b.rule = JSON.stringify({ inclusions: { operator: "or", rules: [{ event_sources: [{ id: pixel_id, type: "pixel" }], retention_seconds: retencao_dias * 86400, filter: { operator: "and", filters: [{ field: "event", operator: "eq", value: "PageView" }] } }] } });
      }
      if (tipo === "ENGAGEMENT") { b.engagement_specs = [{ action_type: engagement_tipo, id: engagement_id }]; b.retention_days = retencao_dias; }
      if (tipo === "CUSTOMER_LIST") { b.customer_file_source = customer_file_source || "USER_PROVIDED_ONLY"; }
      return { content: [{ type: "text", text: JSON.stringify(await metaPost(`${conta_id}/customaudiences`, b), null, 2) }] };
    }
    if (name === "adicionar_pessoas_publico") {
      const { publico_id, emails = [], telefones = [] } = args;
      if (!emails.length && !telefones.length) {
        return { content: [{ type: "text", text: JSON.stringify({ error: "Forneça pelo menos um email ou telefone." }, null, 2) }] };
      }
      // Schema declara os campos presentes, na mesma ordem em que aparecem em cada linha de 'data'.
      const schema = [];
      if (emails.length)     schema.push("EMAIL");
      if (telefones.length)  schema.push("PHONE");
      const linhas = Math.max(emails.length, telefones.length);
      const data = [];
      for (let i = 0; i < linhas; i++) {
        const linha = [];
        if (emails.length)    linha.push(emails[i]    ? hashSha256(normalizarEmail(emails[i]))       : "");
        if (telefones.length) linha.push(telefones[i] ? hashSha256(normalizarTelefone(telefones[i])) : "");
        data.push(linha);
      }
      const resultado = await metaPost(`${publico_id}/users`, { payload: JSON.stringify({ schema, data }) });
      // Nunca ecoar os valores originais de volta — só confirmação e contagem.
      return { content: [{ type: "text", text: JSON.stringify({ publico_id, contactos_enviados: linhas, resultado }, null, 2) }] };
    }
    if (name === "criar_publico_semelhante") {
      const { conta_id, publico_origem_id, paises, tamanho = 1, nome } = args;
      return { content: [{ type: "text", text: JSON.stringify(await metaPost(`${conta_id}/customaudiences`, { name: nome, origin_audience_id: publico_origem_id, lookalike_spec: JSON.stringify({ type: "similarity", ratio: tamanho / 100, countries: paises }) }), null, 2) }] };
    }
    if (name === "atualizar_campanha") {
      const { campanha_id, nome, status, codigo_aprovacao, orcamento_diario, orcamento_total, limite_gasto, data_fim } = args;
      const erro = bloqueiaAtivacaoSemCodigo(status, codigo_aprovacao);
      if (erro) return { content: [{ type: "text", text: JSON.stringify({ error: erro }, null, 2) }] };
      const b = {};
      if (nome)             b.name            = nome;
      if (status)           b.status          = status;
      if (orcamento_diario) b.daily_budget     = String(orcamento_diario);
      if (orcamento_total)  b.lifetime_budget  = String(orcamento_total);
      if (limite_gasto)     b.spend_cap        = String(limite_gasto);
      if (data_fim)         b.stop_time        = data_fim;
      return { content: [{ type: "text", text: JSON.stringify(await metaPost(`${campanha_id}`, b), null, 2) }] };
    }
    if (name === "atualizar_conjunto_anuncios") {
      const { conjunto_id, nome, status, codigo_aprovacao, orcamento_diario, orcamento_total, data_fim, bid_amount } = args;
      const erro = bloqueiaAtivacaoSemCodigo(status, codigo_aprovacao);
      if (erro) return { content: [{ type: "text", text: JSON.stringify({ error: erro }, null, 2) }] };
      const b = {};
      if (nome)             b.name            = nome;
      if (status)           b.status          = status;
      if (orcamento_diario) b.daily_budget     = String(orcamento_diario);
      if (orcamento_total)  b.lifetime_budget  = String(orcamento_total);
      if (data_fim)         b.end_time         = data_fim;
      if (bid_amount)       b.bid_amount       = String(bid_amount);
      return { content: [{ type: "text", text: JSON.stringify(await metaPost(`${conjunto_id}`, b), null, 2) }] };
    }
    if (name === "atualizar_anuncio") {
      const { anuncio_id, nome, status, codigo_aprovacao } = args;
      const erro = bloqueiaAtivacaoSemCodigo(status, codigo_aprovacao);
      if (erro) return { content: [{ type: "text", text: JSON.stringify({ error: erro }, null, 2) }] };
      const b = {};
      if (nome)   b.name   = nome;
      if (status) b.status = status;
      return { content: [{ type: "text", text: JSON.stringify(await metaPost(`${anuncio_id}`, b), null, 2) }] };
    }
    if (name === "aprovar_e_ativar") {
      const { nivel, id, codigo_aprovacao } = args;
      if (!APPROVAL_CODE) return { content: [{ type: "text", text: JSON.stringify({ error: "Ativação bloqueada: APPROVAL_CODE não está configurado no servidor." }, null, 2) }] };
      if (codigo_aprovacao !== APPROVAL_CODE) return { content: [{ type: "text", text: JSON.stringify({ error: "Código de aprovação inválido." }, null, 2) }] };
      if (!["campanha", "conjunto", "anuncio"].includes(nivel)) return { content: [{ type: "text", text: JSON.stringify({ error: "nivel inválido: use 'campanha', 'conjunto' ou 'anuncio'." }, null, 2) }] };
      return { content: [{ type: "text", text: JSON.stringify(await metaPost(`${id}`, { status: "ACTIVE" }), null, 2) }] };
    }
    if (name === "duplicar_campanha") {
      const { campanha_id, conta_destino, novo_nome, status_inicial = "PAUSED", codigo_aprovacao } = args;
      const erro = bloqueiaAtivacaoSemCodigo(status_inicial, codigo_aprovacao);
      if (erro) return { content: [{ type: "text", text: JSON.stringify({ error: erro }, null, 2) }] };
      const b = { status: status_inicial };
      if (conta_destino) b.account_id = conta_destino.replace("act_", "");
      if (novo_nome)     b.name       = novo_nome;
      return { content: [{ type: "text", text: JSON.stringify(await metaPost(`${campanha_id}/copies`, b), null, 2) }] };
    }
    if (name === "pesquisar_interesses") {
      const { termo, locale = "pt_PT" } = args;
      return { content: [{ type: "text", text: JSON.stringify(await metaGet("search", { type: "adinterest", q: termo, locale, fields: "id,name,audience_size_lower_bound,audience_size_upper_bound,path,topic", limit: "30" }), null, 2) }] };
    }
    if (name === "estimar_alcance") {
      const { conta_id, paises, idade_min = 18, idade_max = 65, genero = [], interesses = [], publicos_custom = [], orcamento_diario, objetivo_otimizacao } = args;
      const ts = { age_min: idade_min, age_max: idade_max, geo_locations: { countries: paises } };
      if (genero.length)         ts.genders          = genero;
      if (interesses.length)     ts.interests        = interesses;
      if (publicos_custom.length) ts.custom_audiences = publicos_custom.map(id => ({ id }));
      const p = { targeting_spec: JSON.stringify(ts), optimize_for: objetivo_otimizacao || "LINK_CLICKS" };
      if (orcamento_diario) p.daily_budget = String(orcamento_diario);
      return { content: [{ type: "text", text: JSON.stringify(await metaGet(`${conta_id}/reachestimate`, p), null, 2) }] };
    }

    return { content: [{ type: "text", text: `Ferramenta '${name}' não encontrada` }] };
  });

  return server;
}

// ─── Express + Streamable HTTP ────────────────────────────────────────────────
const app = express();
app.use(express.json());

// CORS
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, x-api-key, mcp-session-id");
  if (req.method === "OPTIONS") { res.sendStatus(204); return; }
  next();
});

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "ok", version: "2.0.0", server: "meta-ads-escala" });
});

// OAuth metadata
app.get("/.well-known/oauth-authorization-server", (req, res) => {
  const base = `${req.protocol}://${req.get("host")}`;
  res.json({
    issuer:                 base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint:         `${base}/oauth/token`,
    registration_endpoint:  `${base}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported:    ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
  });
});

// Alguns clientes MCP pedem primeiro este metadata (RFC 9728) antes do
// oauth-authorization-server — respondemos para não cair em 404.
app.get(["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"], (req, res) => {
  const base = `${req.protocol}://${req.get("host")}`;
  res.json({
    resource: `${base}/mcp`,
    authorization_servers: [base],
  });
});

// OAuth Dynamic Client Registration (RFC 7591) — cada gestor que liga o
// conector recebe automaticamente um client_id próprio, sem passos manuais.
// Aceita GET e POST porque o cliente do Claude usou GET aqui.
app.all("/oauth/register", (req, res) => {
  const { redirect_uris = [], client_name = "meta-ads-escala client" } = req.body || req.query || {};
  res.status(201).json({
    client_id: `escala-client-${randomUUID()}`,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    client_name,
    redirect_uris,
    grant_types: ["authorization_code"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  });
});

// OAuth authorize
app.get("/oauth/authorize", (req, res) => {
  const { redirect_uri, state = "" } = req.query;
  const code = randomUUID();
  res.redirect(`${redirect_uri}?code=${code}&state=${state}`);
});

// OAuth token
app.post("/oauth/token", (req, res) => {
  res.json({
    access_token: `escala-${randomUUID()}`,
    token_type:   "bearer",
    expires_in:   86400,
  });
});

// MCP endpoint — Streamable HTTP
const sessions = new Map();

app.all("/mcp", async (req, res) => {
  try {
    const sessionId = req.headers["mcp-session-id"];

    // Nova sessão
    if (req.method === "POST" && !sessionId) {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => sessions.set(id, transport),
      });
      transport.onclose = () => sessions.delete(transport.sessionId);
      const mcpServer = createMcpServer();
      await mcpServer.connect(transport);
      await transport.handleRequest(req, res, req.body);
      return;
    }

    // Sessão existente
    if (sessionId && sessions.has(sessionId)) {
      const transport = sessions.get(sessionId);
      await transport.handleRequest(req, res, req.body);
      return;
    }

    // Sessão desconhecida (ex.: o servidor reiniciou e perdeu o mapa em
    // memória, mas o cliente ainda envia um mcp-session-id antigo). A
    // especificação do MCP Streamable HTTP diz que o servidor deve responder
    // 404 nesse caso — é o sinal que faz o cliente descartar o ID antigo e
    // reiniciar sozinho a sessão (novo initialize), sem o utilizador ter de
    // desligar/religar o conector manualmente.
    res.status(404).json({ error: "Session not found" });
  } catch (e) {
    process.stderr.write(`[meta-ads-escala] Erro MCP: ${e.message}\n`);
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  process.stdout.write(`[meta-ads-escala] Servidor online na porta ${PORT}\n`);
  process.stdout.write(`[meta-ads-escala] MCP endpoint: http://localhost:${PORT}/mcp\n`);
  process.stdout.write(`[meta-ads-escala] Health: http://localhost:${PORT}/health\n`);
});
