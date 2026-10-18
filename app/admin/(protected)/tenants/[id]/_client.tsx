"use client";
import { Skeleton } from "@/components/ui/skeleton";
import { useTenantDetail } from "@/hooks/useTenantDetail";
import { TenantOverview } from "@/components/admin/tenants/TenantOverview";
import { TenantActions } from "@/components/admin/tenants/TenantActions";
import { TenantAiCard } from "@/components/admin/tenants/TenantAiCard";
import { SuspendedBanner } from "@/components/admin/tenants/SuspendedBanner";
import { TenantMembers } from "@/components/admin/tenants/TenantMembers";
import { useT } from "@/hooks/i18n/useT";

interface TenantOverviewClientProps {
  id: string;
  cobrancaLigada?: boolean;
}

export function TenantOverviewClient({ id, cobrancaLigada = false }: TenantOverviewClientProps) {
  const t = useT();
  const { data, isLoading, isError } = useTenantDetail(id);

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-32 w-full rounded-lg" />
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-20 rounded-lg" />
          ))}
        </div>
        <Skeleton className="h-48 w-full rounded-lg" />
      </div>
    );
  }

  if (isError || !data?.data) {
    return (
      <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-6 py-10 text-center text-sm text-destructive">
        {t("Não foi possível carregar os dados do tenant. Tente recarregar a página.")}
      </div>
    );
  }

  const { organization, counts, integrations } = data.data;
  // Só os dois campos que esta tela lê; o resto de `settings` não é da conta dela.
  const settings = (organization.settings ?? {}) as {
    omnirouter?: { habilitado?: boolean };
    llm?: { default_model?: string };
  };

  return (
    <div className="space-y-6">
      {organization.status === "suspended" && organization.suspended_at && (
        <SuspendedBanner suspendedAt={organization.suspended_at} />
      )}

      <div className="grid gap-6 lg:grid-cols-[1fr_280px]">
        <div className="space-y-6">
          <TenantOverview
            organization={organization}
            counts={counts}
            integrations={integrations}
            cobrancaLigada={cobrancaLigada}
          />
          <TenantAiCard
            organizationId={organization.id}
            initialHabilitado={settings.omnirouter?.habilitado === true}
            initialModel={settings.llm?.default_model || "claude-haiku-5-5"}
          />
          <TenantMembers
            organizationId={organization.id}
            readOnly={organization.status === "redacted"}
          />
        </div>
        <TenantActions organization={organization} counts={counts} />
      </div>
    </div>
  );
}
