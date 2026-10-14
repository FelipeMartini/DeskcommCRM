/**
 * GET/PUT /api/v1/admin/tenants/[id]/ai
 *
 * Gerenciamento centralizado de Inteligência Artificial e OmniRouter por organização
 * exclusivo para Super Administradores da Plataforma (Platform Admin).
 *
 * Permite que o administrador geral do CRM:
 * 1. Habilite ou desabilite o OmniRouter especificamente para este tenant.
 * 2. Configure a Chave API do OmniRouter individual desta organização (ou herde a global).
 * 3. Pré-configure automaticamente a credencial e o modelo padrão (Claude Haiku 5.5).
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
import { OMNIROUTER_BASE_URL } from "@/lib/ai/gateway";
import { guardarCredencial } from "@/lib/ai/credenciais/guardar";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const putAiSchema = z.object({
  habilitado: z.boolean(),
  apiKey: z.string().trim().optional(),
  model: z.string().trim().default("claude-haiku-5-5"),
});

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
  const omnirouterCfg = (settings.omnirouter ?? {}) as Record<string, unknown>;
  const llmCfg = (settings.llm ?? {}) as Record<string, unknown>;

  // Busca credencial OmniRouter ativa da organização
  const { data: cred } = await admin
    .from("ai_provider_credentials")
    .select("id, label, provider, base_url, is_active, created_at, validated_at")
    .eq("organization_id", orgId)
    .eq("provider", "custom")
    .eq("is_active", true)
    .maybeSingle();

  return ok(
    {
      habilitado: omnirouterCfg.habilitado === true,
      provedor_atual: llmCfg.provider ?? "anthropic",
      modelo_atual: llmCfg.default_model ?? "claude-haiku-5-5",
      omnirouter_base_url: OMNIROUTER_BASE_URL,
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

  const { habilitado, apiKey, model } = parsed.data;
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

  if (habilitado) {
    // Chave a usar: fornecida no formulário ou a global OMNIROUTER_API_KEY
    const chaveEfetiva = apiKey || process.env.OMNIROUTER_API_KEY || "";

    if (chaveEfetiva) {
      // Cadastra ou atualiza credencial OmniRouter
      await guardarCredencial({
        admin,
        orgId,
        userId: adminCtx.user.id,
        provider: "custom",
        label: "OmniRouter Corporativo",
        apiKey: chaveEfetiva,
        baseUrl: OMNIROUTER_BASE_URL,
        requestId,
      });
    }

    const novosSettings = {
      ...settingsAtuais,
      omnirouter: {
        ...omnirouterAtual,
        habilitado: true,
        chave_individual: !!apiKey,
        atualizado_em: new Date().toISOString(),
      },
      llm: {
        ...llmAtual,
        provider: "custom",
        default_model: model || "claude-haiku-5-5",
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
    // Desabilita OmniRouter para este tenant
    const novosSettings = {
      ...settingsAtuais,
      omnirouter: {
        ...omnirouterAtual,
        habilitado: false,
        desativado_em: new Date().toISOString(),
      },
    };

    // Desativa credenciais customizadas se houver
    await admin
      .from("ai_provider_credentials")
      .update({ is_active: false })
      .eq("organization_id", orgId)
      .eq("provider", "custom");

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
      chave_individual: !!apiKey,
    },
  });

  return ok({ ok: true, habilitado, model }, { requestId });
}
