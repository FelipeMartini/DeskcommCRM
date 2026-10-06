import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { ensureTenantForUser } from "@/lib/auth/provision";
import { validarTokenSSO } from "@/lib/auth/sso";
import { env } from "@/lib/env";
import { randomBytes } from "node:crypto";

/**
 * GET /api/auth/sso?token=...&embedded=true&next=/app/inbox
 *
 * Endpoint de Single Sign-On (SSO) do DeskcommCRM:
 * Permite que um usuário autenticado no ProjetoSocial entre diretamente
 * no Deskcomm sem tela de login duplicada, vinculando seu e-mail e espaço.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const token = searchParams.get("token");
  const embedded = searchParams.get("embedded") === "true";
  const nextParam = searchParams.get("next") || "/app/inbox";

  const secret = process.env.DESKCOMM_SSO_SECRET || process.env.SSO_SHARED_SECRET;
  if (!secret) {
    console.error("[SSO] DESKCOMM_SSO_SECRET não está configurado no servidor.");
    return NextResponse.redirect(
      new URL("/login?error=sso_unconfigured", env.NEXT_PUBLIC_APP_URL || request.url),
    );
  }

  if (!token) {
    return NextResponse.redirect(
      new URL("/login?error=token_ausente", env.NEXT_PUBLIC_APP_URL || request.url),
    );
  }

  const payload = validarTokenSSO(token, secret);
  if (!payload) {
    return NextResponse.redirect(
      new URL("/login?error=token_invalido_ou_expirado", env.NEXT_PUBLIC_APP_URL || request.url),
    );
  }

  const admin = createAdminClient();

  // 1. Tentar criar o usuário caso ele ainda não exista no Supabase Auth
  let userId: string | null = null;
  try {
    const { data: novoUsuario } = await admin.auth.admin.createUser({
      email: payload.email,
      password: randomBytes(24).toString("base64url"),
      email_confirm: true,
      user_metadata: {
        full_name: payload.name || payload.email.split("@")[0],
        org_name: payload.espaco_nome || "Meu Espaço",
        sso_provider: "projetosocial",
        espaco_id: payload.espaco_id,
      },
    });
    if (novoUsuario?.user) {
      userId = novoUsuario.user.id;
    }
  } catch (err) {
    // Se o usuário já existe, o GoTrue lança ou devolve erro tratado
    console.log("[SSO] Usuário já existente ou erro de criação prévia:", err);
  }

  // 2. Gerar link de autenticação mágica (magiclink) para o GoTrue
  const { data: linkData, error: linkError } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email: payload.email,
  });

  if (linkError || !linkData?.properties?.hashed_token) {
    console.error("[SSO] Erro ao gerar link de autenticação mágica:", linkError?.message);
    return NextResponse.redirect(
      new URL("/login?error=sso_falha_gerar_sessao", env.NEXT_PUBLIC_APP_URL || request.url),
    );
  }

  const tokenHash = linkData.properties.hashed_token;
  const idParaTenant = userId || linkData.user?.id;

  // 3. Garantir vínculo com organização
  if (idParaTenant) {
    try {
      await ensureTenantForUser({
        id: idParaTenant,
        email: payload.email,
        user_metadata: {
          org_name: payload.espaco_nome || "Meu Espaço",
        },
      });
    } catch (e) {
      console.warn("[SSO] Aviso ao vincular tenant:", e);
    }
  }

  // 4. Efetivar sessão no cookie usando createClient + verifyOtp
  const supabase = await createClient();
  const { error: verifyError } = await supabase.auth.verifyOtp({
    type: "magiclink",
    token_hash: tokenHash,
  });

  if (verifyError) {
    console.error("[SSO] Erro ao validar OTP do SSO:", verifyError.message);
    return NextResponse.redirect(
      new URL("/login?error=sso_falha_verificacao", env.NEXT_PUBLIC_APP_URL || request.url),
    );
  }

  // 5. Redirecionar para o destino em modo normal ou embutido
  const baseUrl = env.NEXT_PUBLIC_APP_URL || request.url;
  const destinoUrl = new URL(nextParam, baseUrl);
  if (embedded) {
    destinoUrl.searchParams.set("embedded", "true");
  }

  const response = NextResponse.redirect(destinoUrl);

  if (embedded) {
    response.cookies.set("deskcomm_embedded", "1", {
      path: "/",
      sameSite: "none",
      secure: true,
      maxAge: 60 * 60 * 24 * 7,
    });
  }

  return response;
}
