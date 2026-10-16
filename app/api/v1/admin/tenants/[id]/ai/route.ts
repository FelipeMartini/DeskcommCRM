/**
 * GET/PUT /api/v1/admin/tenants/[id]/ai
 *
 * Gerenciamento centralizado de Inteligência Artificial e OmniRouter por organização
 * exclusivo para Super Administradores da Plataforma (Platform Admin).
 *
 * O MODELO É MISTO (ordem do dono, 16/10/2026):
 *
 * - O ENDEREÇO e a CHAVE PADRÃO do OmniRouter são da INSTALAÇÃO: o administrador da plataforma os grava
 *   em Admin › Configuração › Credenciais (`platform_config`; o `.env` é o piso). Esta rota só os LÊ.
 * - Aqui o administrador faz a ESCOLHA da organização:
 *   1. `habilitado: true` sem `apiKey` — a organização HERDA a conexão da instalação. Nenhuma
 *      credencial é copiada: o motor lê o endereço e a chave da instalação a cada chamada
 *      (`resolveOrgLlmConfig`), então trocar a chave lá vale para todas, sem republicar nada.
 *   2. `habilitado: true` com `apiKey` — a organização usa uma chave INDIVIDUAL do OmniRouter, guardada
 *      como credencial `custom` (BYOK) apontada para o endereço da instalação.
 *   3. `habilitado: false` — a organização NÃO usa o OmniRouter, nem pela oferta geral
 *      (`OMNIROUTER_PARA_TODAS`).
 * - Sem escolha nenhuma, vale a oferta geral da instalação.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import {
  falhaDaEscritaDePlatformAdmin,
  requirePlatformAdmin,
  requirePlatformAdminEscrita,
} from "@/lib/auth/requirePlatformAdmin";
import {
  OmniRouterInvalidoError,
  escolhaDoOmniRouterNasConfiguracoes,
  lerEnderecoDoOmniRouter,
  omniRouterAtendeAOrganizacao,
  omniRouterEscolhido,
} from "@/lib/ai/omnirouter";
import { omniRouterConfigurado, variaveisDoOmniRouterDaInstalacao } from "@/lib/ai/omnirouter-ativo";
import { guardarCredencial, rotacionarCredencial } from "@/lib/ai/credenciais/guardar";
import { validarParProvedorModelo } from "@/lib/ai/par-provedor-modelo";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

/** O rótulo da credencial individual — é também como esta rota a reconhece ao desativá-la. */
const ROTULO_DA_CREDENCIAL = "OmniRouter Corporativo";

const MODELO_PADRAO = "claude-haiku-5-5";

const putAiSchema = z.object({
  habilitado: z.boolean(),
  apiKey: z.string().trim().optional(),
  model: z.string().trim().default(MODELO_PADRAO),
});

/** O endereço da instalação já normalizado, ou `null` quando ausente/torto. Nunca lança. */
function enderecoDaInstalacao(bruto: string | undefined): string | null {
  try {
    return lerEnderecoDoOmniRouter(bruto).baseURL;
  } catch (erro) {
    if (erro instanceof OmniRouterInvalidoError) return null;
    throw erro;
  }
}

/**
 * Guarda a chave individual do OmniRouter como credencial `custom` da organização. Se ela já tem uma
 * (o rótulo é único por organização), a MESMA credencial recebe a chave nova e volta a ficar ativa,
 * apontada para o endereço de hoje da instalação: as versões de agente que apontam para ela seguem
 * valendo. `true` = ficou guardada.
 */
async function guardarChaveIndividual(p: {
  admin: ReturnType<typeof createAdminClient>;
  orgId: string;
  userId: string;
  apiKey: string;
  baseURL: string;
  requestId: string;
}): Promise<boolean> {
  const criada = await guardarCredencial({
    admin: p.admin,
    orgId: p.orgId,
    userId: p.userId,
    provider: "custom",
    label: ROTULO_DA_CREDENCIAL,
    apiKey: p.apiKey,
    baseUrl: p.baseURL,
    requestId: p.requestId,
  });
  if (criada.ok) return true;
  if (criada.motivo !== "label_em_uso") return false;

  const { data: existente } = await p.admin
    .from("ai_provider_credentials")
    .select("id")
    .eq("organization_id", p.orgId)
    .eq("provider", "custom")
    .eq("label", ROTULO_DA_CREDENCIAL)
    .maybeSingle();
  if (!existente) return false;

  const rotacionada = await rotacionarCredencial({
    admin: p.admin,
    orgId: p.orgId,
    userId: p.userId,
    credentialId: existente.id as string,
    provider: "custom",
    apiKey: p.apiKey,
    requestId: p.requestId,
  });
  if (!rotacionada.ok) return false;

  const { error } = await p.admin
    .from("ai_provider_credentials")
    .update({ is_active: true, base_url: p.baseURL })
    .eq("id", existente.id as string)
    .eq("organization_id", p.orgId);
  return !error;
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const { id: orgId } = await params;

  try {
    await requirePlatformAdmin();
  } catch {
    return fail("forbidden", "Requer privilégios de administrador da plataforma", 403, { requestId });
  }

  const admin = createAdminClient();
  const { data: org, error: erroOrg } = await admin
    .from("organizations")
    .select("id, settings")
    .eq("id", orgId)
    .maybeSingle();

  if (erroOrg || !org) {
    return fail("not_found", "Organização não encontrada", 404, { requestId });
  }

  const settings = (org.settings ?? {}) as Record<string, unknown>;
  const escolha = escolhaDoOmniRouterNasConfiguracoes(settings.omnirouter);
  const llmCfg = (settings.llm ?? {}) as Record<string, unknown>;
  const variaveis = await variaveisDoOmniRouterDaInstalacao();

  // Busca credencial OmniRouter individual ativa da organização
  const { data: cred } = await admin
    .from("ai_provider_credentials")
    .select("id, label, provider, base_url, is_active, created_at, validated_at")
    .eq("organization_id", orgId)
    .eq("provider", "custom")
    .eq("is_active", true)
    .maybeSingle();

  return ok(
    {
      // `habilitado` = a organização foi ESCOLHIDA; `escolha` distingue "recusada" (false) de "sem
      // escolha" (null), onde decide a oferta geral; `atendida` é o que o motor fará agora.
      habilitado: escolha === true,
      escolha: escolha ?? null,
      atendida: omniRouterAtendeAOrganizacao(variaveis, escolha),
      instalacao_configurada: omniRouterConfigurado(variaveis),
      oferta_geral: omniRouterEscolhido(undefined, variaveis),
      provedor_atual: llmCfg.provider ?? "anthropic",
      modelo_atual: llmCfg.default_model ?? MODELO_PADRAO,
      // Só o endereço (nunca a chave): é o que a tela mostra.
      omnirouter_base_url: enderecoDaInstalacao(variaveis.OMNIROUTER_BASE_URL) ?? "",
      credencial_configurada: !!cred,
      credencial_detalhes: cred
        ? {
            id: cred.id,
            label: cred.label,
            base_url: cred.base_url,
            validada: !!cred.validated_at,
          }
        : null,
    },
    { requestId },
  );
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const { id: orgId } = await params;

  const supportDenied = await requireSupportWrite(orgId);
  if (supportDenied) return supportDenied;

  let adminCtx: Awaited<ReturnType<typeof requirePlatformAdminEscrita>>;
  try {
    adminCtx = await requirePlatformAdminEscrita();
  } catch (err) {
    return falhaDaEscritaDePlatformAdmin(err, requestId);
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail("validation_failed", "JSON inválido", 400, { requestId });
  }

  const parsed = putAiSchema.safeParse(body);
  if (!parsed.success) {
    return fail("validation_failed", "Campos inválidos", 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }

  const { habilitado, model } = parsed.data;
  // Chave em branco = não informou: a organização herda a da instalação.
  const chaveIndividual = parsed.data.apiKey ? parsed.data.apiKey : null;
  const individual = chaveIndividual !== null;

  const admin = createAdminClient();

  const { data: orgAtual, error: erroOrg } = await admin
    .from("organizations")
    .select("settings")
    .eq("id", orgId)
    .maybeSingle();

  if (erroOrg || !orgAtual) {
    return fail("not_found", "Organização não encontrada", 404, { requestId });
  }

  const settingsAtuais = (orgAtual.settings ?? {}) as Record<string, unknown>;
  const omnirouterAtual = (settingsAtuais.omnirouter ?? {}) as Record<string, unknown>;
  const llmAtual = (settingsAtuais.llm ?? {}) as Record<string, unknown>;

  // Chave em branco numa organização que JÁ tem chave individual = só mudar o modelo/manter a
  // chave dela (não a trocar, em silêncio, pela da instalação).
  const mantemIndividual = !individual && omnirouterAtual.chave_individual === true;
  const usaCredencialPropria = individual || mantemIndividual;

  // Sem endereço do OmniRouter na instalação não há para onde apontar nada: recusa antes de gravar
  // qualquer coisa (o endereço não vem embutido no código). Sem chave da instalação E sem chave
  // individual (nova ou já guardada), a organização ficaria "habilitada" e sem IA — também recusa.
  const variaveis = await variaveisDoOmniRouterDaInstalacao();
  const baseURL = habilitado ? enderecoDaInstalacao(variaveis.OMNIROUTER_BASE_URL) : null;
  if (habilitado) {
    if (baseURL === null) {
      return fail(
        "validation_failed",
        "O OmniRouter não está configurado nesta instalação: o administrador da plataforma define o endereço em Admin › Configuração › Credenciais.",
        422,
        { requestId },
      );
    }
    if (!usaCredencialPropria && !omniRouterConfigurado(variaveis)) {
      return fail(
        "validation_failed",
        "A instalação ainda não tem a chave do OmniRouter: defina-a em Admin › Configuração › Credenciais ou informe uma chave individual para esta organização.",
        422,
        { requestId },
      );
    }
    // O modelo é validado contra o provedor que o motor vai usar (anthropic, quando herda): um nome de
    // outra família é recusado AQUI, e não na primeira mensagem de um cliente.
    const par = validarParProvedorModelo(usaCredencialPropria ? "custom" : "anthropic", model || MODELO_PADRAO);
    if (!par.valido) {
      return fail("validation_failed", `Modelo recusado: ${par.motivo}.`, 422, { requestId });
    }
  }

  if (habilitado) {
    if (chaveIndividual !== null) {
      const guardada = await guardarChaveIndividual({
        admin,
        orgId,
        userId: adminCtx.user.id,
        apiKey: chaveIndividual,
        baseURL: baseURL!,
        requestId,
      });
      if (!guardada) {
        return fail(
          "internal_error",
          "Não foi possível guardar a chave individual do OmniRouter desta organização.",
          500,
          { requestId },
        );
      }
    } else if (!mantemIndividual) {
      // Herda a conexão da instalação: nenhuma chave é copiada, e a cópia que uma versão anterior
      // desta rota deixou (a chave global gravada como credencial `custom`) sai de uso — senão uma
      // troca de chave na instalação nunca chegaria a esta organização.
      await admin
        .from("ai_provider_credentials")
        .update({ is_active: false })
        .eq("organization_id", orgId)
        .eq("provider", "custom")
        .eq("label", ROTULO_DA_CREDENCIAL);
    }

    const novosSettings = {
      ...settingsAtuais,
      omnirouter: {
        ...omnirouterAtual,
        habilitado: true,
        chave_individual: usaCredencialPropria,
        atualizado_em: new Date().toISOString(),
      },
      llm: {
        ...llmAtual,
        provider: usaCredencialPropria ? "custom" : "anthropic",
        default_model: model || MODELO_PADRAO,
      },
    };

    const { error: erroUpdate } = await admin
      .from("organizations")
      .update({ settings: novosSettings })
      .eq("id", orgId);

    if (erroUpdate) {
      return fail("internal_error", erroUpdate.message, 500, { requestId });
    }
  } else {
    // Recusa o OmniRouter para este tenant (vale também contra a oferta geral da instalação).
    const novosSettings = {
      ...settingsAtuais,
      omnirouter: {
        ...omnirouterAtual,
        habilitado: false,
        chave_individual: false,
        desativado_em: new Date().toISOString(),
      },
    };

    // Desativa SÓ a credencial que esta rota criou (pelo rótulo): uma credencial `custom` que a
    // organização cadastrou por conta própria, para outro endereço, não é do OmniRouter.
    await admin
      .from("ai_provider_credentials")
      .update({ is_active: false })
      .eq("organization_id", orgId)
      .eq("provider", "custom")
      .eq("label", ROTULO_DA_CREDENCIAL);

    const { error: erroUpdate } = await admin
      .from("organizations")
      .update({ settings: novosSettings })
      .eq("id", orgId);

    if (erroUpdate) {
      return fail("internal_error", erroUpdate.message, 500, { requestId });
    }
  }

  void audit({
    action: "platform_admin.tenant_omnirouter_configured",
    actorUserId: adminCtx.user.id,
    actingAsPlatformAdmin: true,
    bypassedRls: true,
    organizationId: orgId,
    resourceType: "organization",
    resourceId: orgId,
    requestId,
    metadata: {
      habilitado,
      model,
      chave_individual: individual,
    },
  });

  return ok({ ok: true, habilitado, model }, { requestId });
}
