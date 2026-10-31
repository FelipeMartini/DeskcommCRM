import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * Épico Operação Visível (F1) — memória geral da org (spec harness, migration
 * 0067): documento versionado (versões imutáveis + ponteiro, mesmo padrão de
 * `ai_agents`/`ai_agent_versions`) e entradas de aprendizado (manual/flywheel).
 *
 * GET: estado completo para a tela — documento ativo, histórico de versões e
 * entradas não-propostas. POST: publica conteúdo novo como versão e move o
 * ponteiro (o clique É o gate humano — mesmo padrão de publish de agente).
 *
 * Auth: sessão de navegador OU Bearer `dsk_...`, resolvidos por
 * `lib/api/auth-dual.ts`. A memória é o que TODOS os agentes da organização
 * seguem, então o token precisa do escopo PRÓPRIO `config:read`/`config:write`
 * E de papel admin (`tokenRole`), como a configuração do agente (#2052). A org
 * sai da linha do token, nunca do body, e todo acesso abaixo a filtra à mão
 * (o client do token é o admin).
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail } from "@/lib/api/wrappers";
import { resolveAuthDual, tetoDeEscritaDoToken } from "@/lib/api/auth-dual";
import { audit } from "@/lib/audit";
import { createAdminClient } from "@/lib/supabase/admin";
import { publicarMemoriaDaOrg } from "@/lib/ai/memoria-da-org";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

const postSchema = z.object({ content: z.string().min(1).max(50_000) });

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await resolveAuthDual(req, {
    requestId,
    resource: "org_memory",
    role: "agent",
    scope: "config:read",
    tokenRole: "admin",
  });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.idioma ?? "pt-BR");
  const org = { orgId: authz.organizationId };

  // Rota em `PUBLIC_PATHS` não tem estrangulamento a montante: o teto do token vale
  // também na leitura (mesmo critério de `GET /api/v1/pipelines`).
  const teto = await tetoDeEscritaDoToken(authz, "org_memory", requestId);
  if (teto) return teto;

  const admin = createAdminClient();

  const { data: pointer } = await admin
    .from("org_memory_pointers")
    .select("version_id")
    .eq("organization_id", org.orgId)
    .maybeSingle();

  let document: {
    version_id: string;
    version_number: number;
    content: string;
    created_at: string;
  } | null = null;

  if (pointer?.version_id) {
    const { data: ver } = await admin
      .from("org_memory_versions")
      .select("id, version_number, content, created_at")
      .eq("id", pointer.version_id as string)
      .eq("organization_id", org.orgId)
      .maybeSingle();
    if (ver) {
      document = {
        version_id: ver.id as string,
        version_number: ver.version_number as number,
        content: ver.content as string,
        created_at: ver.created_at as string,
      };
    }
  }

  const { data: versions, error: versionsErr } = await admin
    .from("org_memory_versions")
    .select("id, version_number, created_at")
    .eq("organization_id", org.orgId)
    .order("version_number", { ascending: false });
  if (versionsErr) {
    return fail("internal_error", t("Erro ao carregar versões da memória."), 500, { requestId });
  }

  const { data: entries, error: entriesErr } = await admin
    .from("org_memory_entries")
    .select("id, title, body, source, status, created_at, valid_until")
    .eq("organization_id", org.orgId)
    .neq("status", "proposed")
    .order("created_at", { ascending: false });
  if (entriesErr) {
    return fail("internal_error", t("Erro ao carregar entradas da memória."), 500, { requestId });
  }

  return ok({ document, versions: versions ?? [], entries: entries ?? [] }, { requestId });
}

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await resolveAuthDual(req, {
    requestId,
    resource: "org_memory",
    role: "admin",
    scope: "config:write",
    tokenRole: "admin",
  });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.idioma ?? "pt-BR");
  const { actor, apiTokenId } = authz;
  const org = { orgId: authz.organizationId };
  // `created_by` é uuid SEM FK: token grava `null` (o id do token não é pessoa) e a
  // autoria fica no audit (`actor_api_token_id`).
  const autorId = actor.type === "user" ? actor.id : null;

  const teto = await tetoDeEscritaDoToken(authz, "org_memory", requestId);
  if (teto) return teto;

  const body = await req.json().catch(() => null);
  const parsed = postSchema.safeParse(body);
  if (!parsed.success) {
    return fail("validation_failed", t("content é obrigatório."), 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }

  const admin = createAdminClient();

  const pub = await publicarMemoriaDaOrg(admin, org.orgId, autorId, parsed.data.content);
  if (!pub.ok) {
    return fail(
      "internal_error",
      pub.erro === "versao"
        ? t("Erro ao publicar versão da memória.")
        : t("Erro ao ativar a versão da memória."),
      500,
      { requestId },
    );
  }
  const ver = { id: pub.versionId, version_number: pub.versionNumber };

  await audit({
    action: "ai.org_memory_published",
    actorUserId: autorId,
    actorApiTokenId: apiTokenId ?? null,
    organizationId: org.orgId,
    resourceType: "org_memory_versions",
    resourceId: ver.id as string,
    requestId,
    metadata: { version_number: ver.version_number },
  });

  return ok({ version_id: ver.id, version_number: ver.version_number }, { requestId });
}
